import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { handleFull } from '../src/cli/commands.js';
import { getPendingProjectJobs, getRecentProjectJobs, projectInputHash, saveLlmProjectReview } from '../src/db/project-analysis.js';
import {
  getKnownExternalIds,
  getStats,
  listJobs,
  openDatabase,
  updateJobStatus,
  upsertJobs,
} from '../src/db/client.js';
import { runSearch } from '../src/runner.js';
import {
  getSourceFetcher,
  resolveSourceId,
  resolveSourceIds,
} from '../src/sources/registry.js';
import type { JobListing } from '../src/sources/types.js';

function makeJob(overrides: Partial<JobListing> = {}): JobListing {
  return {
    source: 'mycareersfuture',
    externalId: 'mcf-123',
    url: 'https://www.mycareersfuture.gov.sg/job/it/backend-mcf-123',
    title: 'Senior Backend Engineer',
    company: 'Acme SG Pte Ltd',
    location: 'Singapore',
    salaryMin: 8000,
    salaryMax: 12000,
    salaryCurrency: 'SGD',
    salaryInterval: 'monthly',
    employmentType: 'Full Time',
    descriptionSnippet: 'Build scalable TypeScript services.',
    skills: ['TypeScript', 'SQLite'],
    postedAt: '2026-11-18',
    ...overrides,
  };
}

describe('SQLite job tracker', () => {
  it('persists recent estimates across all statuses and beyond 500 rows, preserving tracker data', (t) => {
    const db = openDatabase(':memory:');
    t.after(() => db.close());
    const now = new Date('2026-11-23T12:00:00Z');
    upsertJobs(db, Array.from({ length: 503 }, (_, i) => makeJob({
      externalId: `recent-${i}`,
      descriptionSnippet: 'Build applications for a government agency.',
      postedAt: '2026-11-23',
    })));
    upsertJobs(db, [
      makeJob({ externalId: 'old', postedAt: '2026-11-15' }),
      makeJob({ externalId: 'relative-old', postedAt: '8d ago' }),
      makeJob({ externalId: 'undated', postedAt: null, descriptionSnippet: null }),
    ]);
    db.prepare("UPDATE jobs SET last_seen_at = '2026-11-23 10:00:00' WHERE source = ?").run('mycareersfuture');
    const first = listJobs(db, { search: 'government agency' })[0];
    updateJobStatus(db, first.id, 'applied', 'Keep these notes');
    const selected = getRecentProjectJobs(db, 7, now);
    const review = {
      model: 'test-model', snapshotAt: now.toISOString(), days: 7,
      decisions: selected.map((job) => ({
        id: job.id, input_hash: projectInputHash(job),
        label: job.description_snippet ? 'Government / public sector' : 'Unclear',
        score: job.description_snippet ? 83 : null,
        evidence: job.description_snippet ?? job.title,
        reasoning: 'Explicit test-supplied decision; importer must preserve the chosen confidence.',
      })),
    };
    assert.throws(() => saveLlmProjectReview(db, { ...review, decisions: review.decisions.slice(1) }), /every pending recent job/);
    assert.equal((db.prepare('SELECT COUNT(*) as count FROM jobs WHERE project_analyzed_at IS NOT NULL').get() as { count: number }).count, 0);
    assert.throws(() => saveLlmProjectReview(db, {
      ...review, decisions: review.decisions.map((d, i) => i ? d : { ...d, evidence: 'Invented government client' }),
    }), /quote the stored listing/);
    assert.throws(() => saveLlmProjectReview(db, {
      ...review, decisions: review.decisions.map((d, i) => i ? d : { ...d, score: 101 }),
    }), /Invalid LLM decision/);
    const result = saveLlmProjectReview(db, review);
    assert.equal(result.updatedCount, 504);
    assert.equal(result.jobs.length, 504);
    assert.equal(result.counts['Government / public sector'], 503);
    assert.equal(result.counts.Unclear, 1);
    const stored = db.prepare('SELECT * FROM jobs WHERE id = ?').get(first.id) as Record<string, unknown>;
    assert.equal(stored.project_probability, 83);
    assert.equal(stored.project_evidence, 'Build applications for a government agency.');
    assert.equal(stored.project_analysis_method, 'llm');
    assert.equal(stored.project_analysis_model, 'test-model');
    assert.ok(stored.project_analyzed_at);
    assert.equal(stored.status, 'applied');
    assert.equal(stored.notes, 'Keep these notes');
    assert.equal(stored.last_seen_at, '2026-11-23 10:00:00');
    assert.equal(getPendingProjectJobs(db, 7, now).length, 0);
    assert.throws(() => saveLlmProjectReview(db, review), /already analyzed/);
    const old = db.prepare('SELECT project_analyzed_at FROM jobs WHERE external_id = ?').get('old') as { project_analyzed_at: string | null };
    assert.equal(old.project_analyzed_at, null);
    upsertJobs(db, [makeJob({ externalId: first.external_id, title: 'Changed title', postedAt: '2026-11-23' })]);
    const changed = db.prepare('SELECT project_analyzed_at FROM jobs WHERE id = ?').get(first.id) as { project_analyzed_at: string | null };
    assert.equal(changed.project_analyzed_at, null);
    assert.throws(() => saveLlmProjectReview(db, review), /changed job/);
  });

  it('reviews only missing or invalidated assessments and preserves valid results including Unclear', (t) => {
    const db = openDatabase(':memory:');
    t.after(() => db.close());
    const now = new Date('2026-11-23T12:00:00Z');
    upsertJobs(db, ['valid', 'unclear', 'changed', 'legacy', 'missing'].map((externalId) =>
      makeJob({ externalId, postedAt: '2026-11-23' })));
    const review = {
      model: 'original-model', snapshotAt: now.toISOString(), days: 7,
      decisions: getPendingProjectJobs(db, 7, now).map((job) => ({
        id: job.id, input_hash: projectInputHash(job),
        label: job.external_id === 'unclear' ? 'Unclear' : 'Technology',
        score: job.external_id === 'unclear' ? null : 72,
        evidence: job.title, reasoning: 'Original assessment supplied by the test.',
      })),
    };
    saveLlmProjectReview(db, review);
    // A routine refresh must not invalidate a completed assessment.
    upsertJobs(db, [makeJob({ externalId: 'valid', postedAt: '2026-11-23' })]);
    const preserved = db.prepare("SELECT * FROM jobs WHERE external_id IN ('valid', 'unclear') ORDER BY id").all();
    upsertJobs(db, [makeJob({ externalId: 'changed', title: 'New project title', postedAt: '2026-11-23' })]);
    db.prepare("UPDATE jobs SET project_analysis_method = 'rules' WHERE external_id = ?").run('legacy');
    db.prepare('UPDATE jobs SET project_analysis_model = NULL WHERE external_id = ?').run('missing');
    const pending = getPendingProjectJobs(db, 7, now);
    assert.deepEqual(pending.map((job) => job.external_id).sort(), ['changed', 'legacy', 'missing']);
    const incremental = {
      ...review, model: 'new-model',
      decisions: pending.map((job) => ({
        id: job.id, input_hash: projectInputHash(job), label: 'Unclear', score: null,
        evidence: job.title, reasoning: 'Listing does not establish the project domain.',
      })),
    };
    assert.throws(() => saveLlmProjectReview(db, {
      ...incremental, decisions: incremental.decisions.slice(1),
    }), /every pending recent job/);
    assert.throws(() => saveLlmProjectReview(db, {
      ...incremental, decisions: [...incremental.decisions, review.decisions[0]],
    }), /already analyzed/);
    const result = saveLlmProjectReview(db, incremental);
    assert.equal(result.updatedCount, 3);
    assert.equal(result.jobs.length, 5);
    assert.deepEqual(result.counts, { Unclear: 3 });
    assert.deepEqual(db.prepare("SELECT * FROM jobs WHERE external_id IN ('valid', 'unclear') ORDER BY id").all(), preserved);
    assert.equal(getPendingProjectJobs(db, 7, now).length, 0);
    const after = db.prepare('SELECT * FROM jobs ORDER BY id').all();
    const noOp = saveLlmProjectReview(db, { ...incremental, decisions: [] });
    assert.equal(noOp.updatedCount, 0);
    assert.equal(noOp.jobs.length, 5);
    assert.deepEqual(db.prepare('SELECT * FROM jobs ORDER BY id').all(), after);
  });

  it('migrates an existing database and can reopen it without adding duplicate columns', (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'job-analysis-migration-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const dbPath = path.join(dir, 'jobs.db');
    const db = openDatabase(dbPath);
    upsertJobs(db, [makeJob()]);
    db.close();
    const reopened = openDatabase(dbPath);
    try {
      assert.equal(listJobs(reopened).length, 1);
      const columns = reopened.pragma('table_info(jobs)') as Array<{ name: string }>;
      assert.equal(columns.filter(({ name }) => name === 'project_probability').length, 1);
    } finally {
      reopened.close();
    }
  });

  for (const query of [undefined, '  Python  ']) {
    it(`writes one combined full report with ${query ? 'a query override' : 'all default queries'}`, async (t) => {
      const db = openDatabase(':memory:');
      const dir = mkdtempSync(path.join(tmpdir(), 'job-search-full-'));
      t.after(() => db.close());
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      t.mock.method(console, 'log', () => {});
      t.mock.method(console, 'table', () => {});
      const out = path.join(dir, 'jobs.html');
      const queries: string[] = [];
      const expectedLimit = query ? 3 : 30;

      const exitCode = await handleFull(db, { query, out, sources: 'mcf', limit: query ? '3' : undefined }, {
        mycareersfuture: async ({ query, limit }) => {
          queries.push(query);
          assert.equal(limit, expectedLimit);
          return {
            jobs: [
              makeJob({ externalId: 'shared', title: 'Shared role', postedAt: '1d ago' }),
              makeJob({ externalId: query, title: `${query} Engineer`, postedAt: '1d ago' }),
            ],
          };
        },
      });

      const expected = query ? ['Python'] : ['Java', 'C#', '.NET', 'Python'];
      assert.equal(exitCode, 0);
      assert.deepEqual(queries, expected);
      assert.deepEqual(readdirSync(dir), ['jobs.html']);
      const html = readFileSync(out, 'utf8');
      const data = html.match(/<script id="jobs-data" type="application\/json">(.*?)<\/script>/s);
      assert.ok(data);
      const jobs = JSON.parse(data[1]) as Array<{ title: string }>;
      assert.deepEqual(
        jobs.map(({ title }) => title).sort(),
        [...expected.map((term) => `${term} Engineer`), 'Shared role'].sort(),
      );
    });
  }

  it('deduplicates re-runs and preserves user status and notes', () => {
    const db = openDatabase(':memory:');
    try {
      const first = upsertJobs(db, [makeJob()]);
      assert.deepEqual(first, { total: 1, inserted: 1, updated: 0 });

      const [stored] = listJobs(db);
      assert.equal(stored.status, 'new');

      const ok = updateJobStatus(db, stored.id, 'applied', 'Referred by Alex');
      assert.equal(ok, true);

      const second = upsertJobs(db, [
        makeJob({
          title: 'Staff Backend Engineer',
          salaryMax: 14000,
        }),
      ]);
      assert.deepEqual(second, { total: 1, inserted: 0, updated: 1 });

      const jobsAfter = listJobs(db);
      assert.equal(jobsAfter.length, 1);
      assert.equal(jobsAfter[0].title, 'Staff Backend Engineer');
      assert.equal(jobsAfter[0].salary_max, 14000);
      assert.equal(jobsAfter[0].status, 'applied');
      assert.equal(jobsAfter[0].notes, 'Referred by Alex');
    } finally {
      db.close();
    }
  });

  it('isolates source failures and blocked responses in runSearch', async () => {
    const db = openDatabase(':memory:');
    try {
      const reports = await runSearch(db, {
        query: 'Software Engineer',
        sources: ['mycareersfuture', 'jobstreet'],
        limit: 10,
        fetchers: {
          mycareersfuture: async () => ({
            jobs: [makeJob({ externalId: 'mcf-ok-1' })],
          }),
          jobstreet: async () => ({
            jobs: [],
            blockedReason: 'CAPTCHA detected',
          }),
        },
      });

      assert.equal(reports.length, 2);
      assert.equal(reports[0].status, 'success');
      assert.equal(reports[0].jobsNew, 1);
      assert.equal(reports[1].status, 'blocked');
      assert.equal(reports[1].error, 'CAPTCHA detected');

      const stats = getStats(db);
      assert.equal(stats.recentRuns.length, 2);
      assert.equal(listJobs(db).length, 1);
    } finally {
      db.close();
    }
  });

  it('records failed status when a fetcher throws', async () => {
    const db = openDatabase(':memory:');
    try {
      const reports = await runSearch(db, {
        query: 'DevOps',
        sources: ['mycareersfuture'],
        limit: 5,
        fetchers: {
          mycareersfuture: async () => {
            throw new Error('Network timeout');
          },
        },
      });

      assert.equal(reports[0].status, 'failed');
      assert.equal(reports[0].error, 'Network timeout');
    } finally {
      db.close();
    }
  });

  it('passes knownIds to fetchers on repeat runs', async () => {
    const db = openDatabase(':memory:');
    try {
      let seenCountOnSecondRun = -1;

      await runSearch(db, {
        query: 'Java',
        sources: ['mycareersfuture'],
        limit: 10,
        fetchers: {
          mycareersfuture: async () => ({
            jobs: [makeJob({ externalId: 'mcf-seen-1' })],
          }),
        },
      });

      assert.equal(getKnownExternalIds(db, 'mycareersfuture').has('mcf-seen-1'), true);

      await runSearch(db, {
        query: 'Java',
        sources: ['mycareersfuture'],
        limit: 10,
        fetchers: {
          mycareersfuture: async (opts) => {
            seenCountOnSecondRun = opts.knownIds?.size ?? 0;
            return { jobs: [] };
          },
        },
      });

      assert.equal(seenCountOnSecondRun, 1);
    } finally {
      db.close();
    }
  });

  it('resolves source plugins and aliases from the central registry', () => {
    assert.equal(resolveSourceId('mcf'), 'mycareersfuture');
    assert.equal(resolveSourceId('GH'), 'greenhouse');
    assert.equal(resolveSourceId('unknown-board'), undefined);
    assert.deepEqual(resolveSourceIds('gh,js'), ['greenhouse', 'jobstreet']);
    assert.throws(() => resolveSourceIds('gh,unknown-board'), /Unknown job source/);
    assert.ok(getSourceFetcher('mycareersfuture'));
    assert.equal(getSourceFetcher('unknown-board'), undefined);
  });

  it('returns per-source totals, new counts, and latest_last_seen in getStats', () => {
    const db = openDatabase(':memory:');
    try {
      const emptyStats = getStats(db);
      assert.deepEqual(emptyStats.byStatus, []);
      assert.deepEqual(emptyStats.bySource, []);
      assert.deepEqual(emptyStats.recentRuns, []);

      upsertJobs(db, [
        makeJob({ source: 'jobstreet', externalId: 'js-1' }),
        makeJob({ source: 'jobstreet', externalId: 'js-2' }),
        makeJob({ source: 'mycareersfuture', externalId: 'mcf-1' }),
      ]);
      const [firstJs] = listJobs(db, { source: 'jobstreet' });
      updateJobStatus(db, firstJs.id, 'saved');

      const stats = getStats(db);
      const jsRow = stats.bySource.find((r) => r.source === 'jobstreet');
      const mcfRow = stats.bySource.find((r) => r.source === 'mycareersfuture');

      assert.ok(jsRow);
      assert.equal(jsRow.total, 2);
      assert.equal(jsRow.new_count, 1);
      assert.ok(jsRow.latest_last_seen);

      assert.ok(mcfRow);
      assert.equal(mcfRow.total, 1);
      assert.equal(mcfRow.new_count, 1);
      assert.ok(mcfRow.latest_last_seen);
    } finally {
      db.close();
    }
  });
});
