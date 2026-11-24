import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, it } from 'node:test';
import { DB_COMMANDS } from '../src/cli/commands.js';
import { listJobs, openDatabase, updateJobStatus, upsertJobs } from '../src/db/client.js';
import {
  getPendingCompanies, readCompanyResearch, saveCompanyReview, type CompanyResearch,
} from '../src/db/company-research.js';
import { getPendingProjectJobs, projectInputHash, saveLlmProjectReview } from '../src/db/project-analysis.js';
import type { JobListing } from '../src/sources/types.js';
import { generateHtmlReport } from '../src/report/html.js';

const now = new Date('2026-11-24T12:00:00Z');
function listing(id: string, company = 'Acme SG Pte Ltd'): JobListing {
  return {
    source: 'mycareersfuture', externalId: id, url: `https://example.com/jobs/${id}`,
    title: 'Developer', company, location: 'Singapore', salaryMin: null, salaryMax: null,
    salaryCurrency: 'SGD', salaryInterval: null, employmentType: null,
    descriptionSnippet: null, skills: [], postedAt: '2026-11-24',
  };
}
function research(company = 'Acme SG Pte Ltd'): CompanyResearch {
  return {
    version: 1, company, model: 'test-model', researchedAt: now.toISOString(),
    identity: 'The company website identifies this Singapore employer.',
    summary: 'A small software company; founder and employee reviews could not be verified.',
    size: 'small',
    glassdoor: { status: 'unavailable', url: null, rating: null, reviewCount: null, summary: 'Access blocked.' },
    founders: { status: 'not_found', names: [], summary: 'No founder identified in searched sources.' },
    queries: [`${company} company`, `${company} Glassdoor reviews`, `${company} founders`],
    sources: [{ url: 'https://example.com/about', title: 'Company website', evidence: 'Small software company' }],
  };
}
function review(db: Database.Database, company?: string) {
  return {
    snapshotAt: now.toISOString(), days: 7, company,
    decisions: getPendingCompanies(db, 7, now, company).map((item) => ({
      input_hash: item.input_hash, research: research(item.company),
    })),
  };
}

describe('LLM company web research', () => {
  it('migrates a legacy database idempotently without changing existing jobs', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'company-migration-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'jobs.db');
    const legacy = new Database(file);
    const schema = fs.readFileSync('src/db/schema.sql', 'utf8').replace('    company_research_json TEXT,\n', '');
    legacy.exec(schema);
    legacy.prepare("INSERT INTO jobs (source, external_id, url, title, company, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?)").
      run('jobstreet', 'old', 'https://example.com', 'Developer', 'Legacy', 'saved', 'Keep me');
    legacy.close();
    for (let i = 0; i < 2; i++) {
      const db = openDatabase(file);
      try {
        assert.equal((db.pragma('table_info(jobs)') as Array<{ name: string }>).
          filter((c) => c.name === 'company_research_json').length, 1);
        const [job] = listJobs(db);
        assert.equal(job.status, 'saved');
        assert.equal(job.notes, 'Keep me');
        assert.equal(job.company_research_json, null);
      } finally { db.close(); }
    }
  });

  it('deduplicates companies beyond 500 jobs across statuses, preserves project data, and reuses research', (t) => {
    const db = openDatabase(':memory:');
    t.after(() => db.close());
    upsertJobs(db, Array.from({ length: 501 }, (_, i) => listing(`${i}`)));
    upsertJobs(db, [listing('other', 'Other SG Pte Ltd')]);
    const [first] = listJobs(db);
    updateJobStatus(db, first.id, 'applied', 'Keep notes');
    saveLlmProjectReview(db, {
      snapshotAt: now.toISOString(), days: 7, model: 'original-model',
      decisions: getPendingProjectJobs(db, 7, now).map((j) => ({
        id: j.id, input_hash: projectInputHash(j), label: 'Unclear', score: null,
        evidence: j.title, reasoning: 'Generic role without project details.',
      })),
    });
    const before = db.prepare('SELECT project_analyzed_at, project_analysis_model, status, notes FROM jobs ORDER BY id').all();
    const pending = getPendingCompanies(db, 7, now);
    assert.equal(pending.length, 2);
    assert.equal(pending.find((c) => c.company === 'Acme SG Pte Ltd')?.jobs.length, 501);
    const result = saveCompanyReview(db, review(db));
    assert.equal(result.updatedCompanies, 2);
    assert.equal(result.updatedJobs, 502);
    assert.equal(result.jobs.length, 502);
    assert.deepEqual(db.prepare('SELECT project_analyzed_at, project_analysis_model, status, notes FROM jobs ORDER BY id').all(), before);
    assert.equal(getPendingCompanies(db, 7, now).length, 0);
    const original = listJobs(db)[0].company_research_json;
    upsertJobs(db, [listing('next', 'Other SG Pte Ltd')]);
    assert.equal(listJobs(db)[0].company_research_json, original);
    upsertJobs(db, [listing('next', 'Unresearched SG')]);
    assert.equal(listJobs(db)[0].company_research_json, null);
    assert.deepEqual(getPendingCompanies(db, 7, now).map((c) => c.company), ['Unresearched SG']);
  });

  it('rejects partial, duplicate, stale, fabricated provenance and unsafe sources before any writes', (t) => {
    const db = openDatabase(':memory:');
    t.after(() => db.close());
    upsertJobs(db, [listing('one'), listing('two', 'Other SG Pte Ltd')]);
    const input = review(db);
    assert.throws(() => saveCompanyReview(db, { ...input, decisions: input.decisions.slice(1) }), /every pending company/);
    assert.throws(() => saveCompanyReview(db, { ...input, decisions: [input.decisions[0], input.decisions[0]] }), /duplicate/);
    for (const mutate of [
      (r: CompanyResearch) => { r.queries = [`${r.company} company`]; },
      (r: CompanyResearch) => { r.sources[0].url = 'javascript:alert(1)'; },
      (r: CompanyResearch) => { r.glassdoor = { status: 'found', url: 'https://example.com/reviews', rating: 4, reviewCount: 2, summary: 'Good' }; },
      (r: CompanyResearch) => { r.founders = { status: 'found', names: ['Invented Founder'], summary: 'Founded company' }; },
      (r: CompanyResearch) => { r.researchedAt = 'invalid'; },
      (r: CompanyResearch) => { r.glassdoor.rating = 4; },
    ]) {
      const changed = structuredClone(input);
      mutate(changed.decisions[0].research);
      assert.throws(() => saveCompanyReview(db, changed), /Invalid web research/);
    }
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE company_research_json IS NOT NULL').get() as { n: number }).n, 0);
    upsertJobs(db, [listing('one', 'Renamed company')]);
    assert.throws(() => saveCompanyReview(db, input), /out-of-scope or changed/);
    assert.equal(readCompanyResearch('{broken', 'Acme'), null);
  });

  it('validates found reviews and sourced founders, and imports empty research without changing records', (t) => {
    const db = openDatabase(':memory:');
    t.after(() => db.close());
    upsertJobs(db, [listing('one')]);
    const input = review(db);
    const r = input.decisions[0].research;
    r.glassdoor = { status: 'found', url: 'https://www.glassdoor.com/Reviews/Acme-Reviews-E1.htm', rating: 3.5, reviewCount: 4, summary: 'Mixed employee opinions.' };
    r.founders = { status: 'found', names: ['Test Founder'], summary: 'Official biography identifies the founder.' };
    r.sources.push(
      { url: r.glassdoor.url!, title: 'Glassdoor', evidence: '3.5 from 4 reviews' },
      { url: 'https://example.com/founder', title: 'Founder biography', evidence: 'Test Founder founded Acme.' },
    );
    saveCompanyReview(db, input);
    const before = db.prepare('SELECT * FROM jobs').all();
    const noop = saveCompanyReview(db, { ...input, decisions: [] });
    assert.equal(noop.updatedCompanies, 0);
    assert.deepEqual(db.prepare('SELECT * FROM jobs').all(), before);
    assert.throws(() => saveCompanyReview(db, input), /already researched/);
  });

  it('exports an exact company scope and generates a report through the CLI handler', async (t) => {
    const db = openDatabase(':memory:');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'company-cli-'));
    t.after(() => db.close());
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    t.mock.method(console, 'log', () => {});
    upsertJobs(db, [listing('one'), listing('two', 'Other SG Pte Ltd')]);
    const file = path.join(dir, 'input.json');
    assert.equal(await DB_COMMANDS.research(db, { company: 'Acme SG Pte Ltd', out: file }), 0);
    const exported = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(exported.companies.length, 1);
    assert.equal(exported.company, 'Acme SG Pte Ltd');
    const input = {
      snapshotAt: exported.snapshotAt, days: exported.days, company: exported.company,
      decisions: exported.companies.map((c: { input_hash: string; company: string }) => ({
        input_hash: c.input_hash, research: research(c.company),
      })),
    };
    fs.writeFileSync(file, JSON.stringify(input));
    const report = path.join(dir, 'report.html');
    assert.equal(await DB_COMMANDS.research(db, { input: file, out: report }), 0);
    assert.ok(fs.readFileSync(report, 'utf8').includes('<th>Company Research</th>'));
    assert.equal(getPendingCompanies(db, 7, now).length, 1);
  });

  it('embeds research safely and leaves unresearched companies visible', (t) => {
    const db = openDatabase(':memory:');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'company-html-'));
    t.after(() => db.close());
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    upsertJobs(db, [listing('one')]);
    const r = research();
    r.summary = 'Company </script><script>alert(1)</script>';
    const input = review(db);
    input.decisions[0].research = r;
    saveCompanyReview(db, input);
    upsertJobs(db, [listing('unresearched', 'Pending Employer')]);
    const file = generateHtmlReport(listJobs(db), { outPath: path.join(dir, 'report.html') });
    const html = fs.readFileSync(file, 'utf8');
    assert.ok(!html.includes('</script><script>alert(1)</script>'));
    const data = JSON.parse(html.match(/<script id="jobs-data" type="application\/json">(.*?)<\/script>/s)![1]);
    assert.equal(data.find((job: { company: string }) => job.company === r.company).companyResearch.summary, r.summary);
    assert.equal(data.find((job: { company: string }) => job.company === 'Pending Employer').companyResearch, null);
  });
});
