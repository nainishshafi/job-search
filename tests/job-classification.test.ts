import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { parseCliArgs, VALID_STATUSES } from '../src/cli/args.js';
import { DB_COMMANDS } from '../src/cli/commands.js';
import type { ClassifierDecision, ClassifierRubric } from '../src/classifier.js';
import { listJobs, openDatabase, upsertJobs, type StoredJob } from '../src/db/client.js';
import {
  buildClassificationBatch, classificationDatabaseId, loadJobRubric, matchesClassification,
  readJobClassification, saveClassificationBatch, validateClassificationFilter,
  type ClassificationBatch, type SavedJobClassification,
} from '../src/job-classification.js';
import type { JobListing } from '../src/sources/types.js';

const rubric: ClassifierRubric = {
  version: 1,
  dimensions: {
    domain: { Banking: 'Banking systems', Healthcare: 'Healthcare systems', Unclear: 'Insufficient evidence' },
    role: { Backend: 'Backend services', Frontend: 'Browser interfaces', Unclear: 'Insufficient evidence' },
    technology: { Java: 'Java language', Python: 'Python language', Unclear: 'Insufficient evidence' },
  },
};
const now = new Date('2026-01-10T12:00:00.000Z');
type ReviewInput = Omit<ClassificationBatch, 'jobs'> & { model: string; decisions: ClassifierDecision[] };

function listing(index: number): JobListing {
  return {
    source: 'mycareersfuture', externalId: `classification-${index}`,
    url: `https://example.test/${index}`, title: `Backend developer ${index}`,
    company: 'Example banking company', location: 'Singapore',
    salaryMin: 5000, salaryMax: 8000, salaryCurrency: 'SGD', salaryInterval: 'monthly',
    employmentType: 'Full time',
    descriptionSnippet: 'Build banking backend services in Java and Python with healthcare browser interfaces.',
    skills: ['Java', 'Python'], postedAt: '2020-01-01',
  };
}
function fixture(t: TestContext, count = 6, dbPath = ':memory:') {
  const db = openDatabase(dbPath);
  t.after(() => { if (db.open) db.close(); });
  upsertJobs(db, Array.from({ length: count }, (_, index) => listing(index)));
  db.prepare(`UPDATE jobs SET status = 'applied', notes = 'Keep my notes',
    first_seen_at = '2020-01-01 00:00:00', last_seen_at = '2020-01-02 00:00:00',
    project_type = 'Legacy domain', project_probability = 73, project_evidence = 'banking',
    project_analyzed_at = '2020-01-01T00:00:00.000Z', project_analysis_method = 'llm',
    project_analysis_model = 'legacy-model', project_reasoning = 'Keep my reasoning',
    company_research_json = '{"preserve":"opaque research payload"}'`).run();
  return db;
}
function rows(db: ReturnType<typeof openDatabase>): StoredJob[] {
  return db.prepare('SELECT * FROM jobs ORDER BY id').all() as StoredJob[];
}
function review(batch: ClassificationBatch, role = 'Backend'): ReviewInput {
  const { jobs, ...metadata } = batch;
  return {
    ...metadata, model: 'harness-test-model',
    decisions: jobs.map(job => ({
      id: job.id, input_hash: job.input_hash,
      domain: { label: 'Banking', score: 80, evidence: 'banking', reasoning: 'The quoted text names banking.' },
      role: { label: role, score: 90, evidence: 'backend services', reasoning: 'The quote names backend work.' },
      technology: { labels: ['Java', 'Python'], score: 85, evidence: 'Java and Python', reasoning: 'Both languages are explicit.' },
    })),
  };
}
function unclear(decision: ClassifierDecision): void {
  decision.domain = { ...decision.domain, label: 'Unclear', score: null };
  decision.role = { ...decision.role, label: 'Unclear', score: null };
  decision.technology = { ...decision.technology, labels: ['Unclear'], score: null };
}
function withoutClassification(job: StoredJob) {
  const { classification_json, ...rest } = job;
  return rest;
}
function cliFixture(t: TestContext, count = 6) {
  const originalCwd = process.cwd();
  const actualRubric = loadJobRubric();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'job-classification-test-'));
  fs.mkdirSync(path.join(directory, 'config'));
  const rubricPath = path.join(directory, 'config', 'job-classifier.json');
  fs.writeFileSync(rubricPath, JSON.stringify(actualRubric));
  const dbPath = path.join(directory, 'jobs.db');
  const db = fixture(t, count, dbPath);
  t.after(() => {
    process.chdir(originalCwd);
    if (db.open) db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  process.chdir(directory);
  t.mock.method(console, 'log', () => {});
  const artifacts = path.join(directory, 'data', 'classifier');
  const pendingPath = path.join(artifacts, `pending-jobs-${classificationDatabaseId(db)}.json`);
  return { db, directory, dbPath, rubricPath, artifacts, pendingPath, actualRubric };
}

describe('job classification authoritative batches', () => {
  it('exports all ages and statuses in stable ID order with a bounded default and no row changes', t => {
    const db = fixture(t, 143);
    const update = db.prepare('UPDATE jobs SET status = ?, posted_at = ?, last_seen_at = ? WHERE id = ?');
    for (let id = 1; id <= 143; id++) {
      update.run([...VALID_STATUSES][(id - 1) % VALID_STATUSES.size],
        id % 2 ? '2000-01-01' : '2026-01-10', id % 2 ? '2000-01-01' : '2026-01-10', id);
    }
    db.prepare('UPDATE jobs SET description_snippet = NULL WHERE id = 1').run();
    const before = rows(db);
    const batch = buildClassificationBatch(db, rubric, undefined, now);
    assert.equal(batch.jobs.length, 40);
    assert.deepEqual(batch.jobs.map(job => job.id), Array.from({ length: 40 }, (_, i) => i + 1));
    assert.equal(batch.jobs[0].description, null);
    assert.deepEqual(new Set(batch.jobs.map(job => before[job.id - 1].status)), VALID_STATUSES);
    const next = buildClassificationBatch(db, rubric, undefined, now);
    assert.deepEqual(next.jobs, batch.jobs);
    assert.equal(next.databaseId, batch.databaseId);
    assert.notEqual(next.batchId, batch.batchId);
    assert.equal(buildClassificationBatch(db, rubric, 100, now).jobs.length, 100);
    for (const limit of [0, -1, 1.5, 101, Infinity, NaN]) {
      assert.throws(() => buildClassificationBatch(db, rubric, limit, now), /limit/);
    }
    assert.deepEqual(rows(db), before);
  });

  it('rejects incomplete coverage and late invalid quotes, hashes, duplicates and out-of-batch IDs atomically', t => {
    const db = fixture(t, 4);
    const batch = buildClassificationBatch(db, rubric, 3, now);
    const input = review(batch);
    const cases: Array<[string, (copy: ReviewInput) => void, RegExp]> = [
      ['missing decision', copy => copy.decisions.pop(), /exact exported batch/],
      ['extra decision', copy => copy.decisions.push(copy.decisions[0]), /exact exported batch/],
      ['late hash', copy => copy.decisions[2].input_hash = 'forged', /source hash/],
      ['late duplicate', copy => copy.decisions[2] = copy.decisions[0], /Duplicate/],
      ['late out-of-batch', copy => copy.decisions[2].id = 4, /out-of-batch/],
      ['batch identity', copy => copy.batchId = 'another batch', /exported batch manifest/],
    ];
    for (const dimension of ['domain', 'role', 'technology'] as const) {
      cases.push([`late ${dimension} quote`, copy => copy.decisions[2][dimension].evidence = 'Java Python', /quote/]);
    }
    const before = rows(db);
    for (const [name, mutate, error] of cases) {
      const copy = structuredClone(input);
      mutate(copy);
      assert.throws(() => saveClassificationBatch(db, copy, batch, rubric, now), error, name);
      assert.deepEqual(rows(db), before, name);
    }
    assert.deepEqual(saveClassificationBatch(db, input, batch, rubric, now), { updatedCount: 3, preservedCount: 0 });
  });

  it('preserves every row field except classification_json and replays without replacing saved bytes or timestamps', t => {
    const db = fixture(t, 4);
    const batch = buildClassificationBatch(db, rubric, 3, now);
    const input = review(batch);
    const before = rows(db);
    // Decision order need not match export order.
    input.decisions.reverse();
    assert.deepEqual(saveClassificationBatch(db, input, batch, rubric, now), { updatedCount: 3, preservedCount: 0 });
    const after = rows(db);
    assert.deepEqual(after.map(withoutClassification), before.map(withoutClassification));
    assert.deepEqual(after[3], before[3]);
    for (const job of after.slice(0, 3)) {
      const saved = readJobClassification(job, rubric, now);
      assert.ok(saved);
      assert.equal(saved.classifiedAt, now.toISOString());
      assert.deepEqual(saved.decision, input.decisions.find(decision => decision.id === job.id));
      assert.equal(saved.model, input.model);
    }
    assert.deepEqual(saveClassificationBatch(db, input, batch, rubric, new Date(+now + 86400000)),
      { updatedCount: 0, preservedCount: 3 });
    assert.deepEqual(rows(db), after);
    // An earlier pending row must not get updated if a later valid row conflicts.
    db.prepare('UPDATE jobs SET classification_json = NULL WHERE id = 1').run();
    const beforeConflict = rows(db);
    for (const mutate of [
      (copy: ReviewInput) => { copy.model = 'different-model'; },
      (copy: ReviewInput) => { copy.decisions[copy.decisions.length - 1].role.reasoning = 'Different judgment'; },
      (copy: ReviewInput) => { copy.decisions[copy.decisions.length - 1].domain.score = 81; },
    ]) {
      const copy = structuredClone(input);
      copy.decisions.sort((a, b) => a.id - b.id);
      // Keep the first row valid and pending; change the last already-classified row.
      const first = copy.decisions.shift()!;
      mutate(copy);
      copy.decisions.unshift(first);
      assert.throws(() => saveClassificationBatch(db, copy, batch, rubric, now), /Conflicting/);
      assert.deepEqual(rows(db), beforeConflict);
    }
  });

  it('allows unrelated corpus growth but rejects changed selected sources, stale manifests and database mismatches', t => {
    const db = fixture(t, 3);
    const batch = buildClassificationBatch(db, rubric, 2, now);
    const input = review(batch);
    upsertJobs(db, [listing(100)]);
    assert.deepEqual(saveClassificationBatch(db, input, batch, rubric, now), { updatedCount: 2, preservedCount: 0 });
    assert.equal(rows(db)[3].classification_json, null);
    const other = fixture(t, 3);
    const beforeOther = rows(other);
    assert.notEqual(classificationDatabaseId(db), classificationDatabaseId(other));
    assert.throws(() => saveClassificationBatch(other, input, batch, rubric, now), /database or rubric mismatch/);
    assert.deepEqual(rows(other), beforeOther);
    const before = rows(db);
    assert.throws(() => saveClassificationBatch(db, input, batch, rubric, new Date(+now + 7 * 86400000)), /expired/);
    for (const altered of [
      { ...rubric, version: 2 },
      { ...rubric, dimensions: { ...rubric.dimensions, domain: { ...rubric.dimensions.domain, Banking: 'Changed definition' } } },
    ]) {
      assert.throws(() => saveClassificationBatch(db, input, batch, altered, now), /rubric mismatch/);
    }
    assert.deepEqual(rows(db), before);
    db.prepare('UPDATE jobs SET title = ? WHERE id = 2').run('Changed selected source');
    const changed = rows(db);
    assert.throws(() => saveClassificationBatch(db, input, batch, rubric, now), /Changed classification source since export/);
    assert.deepEqual(rows(db), changed);
  });

  it('accepts an empty authoritative batch without changing the database', t => {
    const db = fixture(t, 0);
    const batch = buildClassificationBatch(db, rubric, undefined, now);
    assert.deepEqual(batch.jobs, []);
    assert.deepEqual(saveClassificationBatch(db, review(batch), batch, rubric, now), { updatedCount: 0, preservedCount: 0 });
    assert.deepEqual(rows(db), []);
  });
});

describe('persisted classification validity and scrape integration', () => {
  it('preserves classifications through COALESCE scrapes and invalidates each changed source field', t => {
    for (const field of ['title', 'company', 'descriptionSnippet'] as const) {
      const db = fixture(t, 1);
      const batch = buildClassificationBatch(db, rubric, 1, now);
      saveClassificationBatch(db, review(batch), batch, rubric, now);
      const before = rows(db)[0];
      const scrape = { ...listing(0), descriptionSnippet: null, salaryMin: null,
        salaryMax: null, salaryInterval: null, employmentType: null, postedAt: null };
      assert.deepEqual(upsertJobs(db, [scrape]), { total: 1, inserted: 0, updated: 1 });
      const coalesced = rows(db)[0];
      assert.equal(coalesced.description_snippet, before.description_snippet);
      assert.equal(coalesced.salary_min, before.salary_min);
      assert.equal(coalesced.posted_at, before.posted_at);
      assert.equal(coalesced.classification_json, before.classification_json);
      assert.ok(readJobClassification(coalesced, rubric, now));
      upsertJobs(db, [{ ...listing(0), location: 'Remote', salaryMin: 6000,
        skills: ['Java'], postedAt: '2026-01-10' }]);
      assert.ok(readJobClassification(rows(db)[0], rubric, now), 'Non-source changes remain valid');
      upsertJobs(db, [{ ...listing(0), [field]: `Changed ${field}` }]);
      const changed = rows(db)[0];
      assert.equal(changed.classification_json, before.classification_json, 'Stale payload is retained, not erased');
      assert.equal(readJobClassification(changed, rubric, now), null, field);
      assert.deepEqual(buildClassificationBatch(db, rubric, 1, now).jobs.map(job => job.id), [1]);
      assert.throws(() => saveClassificationBatch(db, review(batch), batch, rubric, now), /Changed classification source/);
    }
  });

  it('exports corrupt, source-stale and rubric-stale rows as pending but not completed Unclear', t => {
    const db = fixture(t, 7);
    const batch = buildClassificationBatch(db, rubric, 7, now);
    const input = review(batch);
    unclear(input.decisions[5]);
    saveClassificationBatch(db, input, batch, rubric, now);
    const write = db.prepare('UPDATE jobs SET classification_json = ? WHERE id = ?');
    write.run('{broken JSON', 2);
    for (const [id, patch] of [[3, { rubricVersion: 2 }], [4, { rubricHash: 'stale' }]] as const) {
      write.run(JSON.stringify({ ...JSON.parse(rows(db)[id - 1].classification_json!), ...patch }), id);
    }
    db.prepare("UPDATE jobs SET title = 'Changed source' WHERE id = 5").run();
    write.run(null, 7);
    const before = rows(db);
    assert.deepEqual(before.map(job => !!readJobClassification(job, rubric, now)),
      [true, false, false, false, false, true, false]);
    const savedUnclear = readJobClassification(before[5], rubric, now)!;
    assert.equal(savedUnclear.decision.domain.score, null);
    assert.deepEqual(savedUnclear.decision.technology.labels, ['Unclear']);
    assert.deepEqual(buildClassificationBatch(db, rubric, 100, now).jobs.map(job => job.id), [2, 3, 4, 5, 7]);
    for (const patch of [
      { schemaVersion: 2 }, { model: '' }, { input_hash: 'bad' },
      { classifiedAt: 'invalid' }, { classifiedAt: new Date(+now + 1).toISOString() },
      { decision: { ...savedUnclear.decision, domain: { ...savedUnclear.decision.domain, score: 0 } } },
    ]) {
      assert.equal(readJobClassification({ ...before[5], classification_json: JSON.stringify({ ...savedUnclear, ...patch }) },
        rubric, now), null);
    }
    const revised = { ...rubric, version: 2 };
    assert.deepEqual(buildClassificationBatch(db, revised, 100, now).jobs.map(job => job.id), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(rows(db), before);
  });
});

describe('classification filters in the client and CLI', () => {
  it('ANDs dimensions while including pending and per-dimension Unclear by default, excluding them in strict mode', t => {
    const actual = loadJobRubric();
    const db = fixture(t, 11);
    const batch = buildClassificationBatch(db, actual, 11, now);
    const input = review(batch, 'Backend development');
    for (const decision of input.decisions) decision.technology.labels = ['Java'];
    input.decisions[1].domain.label = 'Healthcare';
    input.decisions[2].role.label = 'Frontend development';
    input.decisions[3].technology.labels = ['Python'];
    input.decisions[4].domain = { ...input.decisions[4].domain, label: 'Unclear', score: null };
    input.decisions[8].role = { ...input.decisions[8].role, label: 'Unclear', score: null };
    input.decisions[9].technology = { ...input.decisions[9].technology, labels: ['Unclear'], score: null };
    input.decisions[10].domain = { ...input.decisions[10].domain, label: 'Unclear', score: null };
    input.decisions[10].role.label = 'Frontend development';
    saveClassificationBatch(db, input, batch, actual, now);
    db.prepare('UPDATE jobs SET classification_json = NULL WHERE id = 6').run();
    db.prepare("UPDATE jobs SET classification_json = '{broken' WHERE id = 7").run();
    const stale = JSON.parse(rows(db)[7].classification_json!) as SavedJobClassification;
    stale.rubricHash = 'outdated';
    db.prepare('UPDATE jobs SET classification_json = ? WHERE id = 8').run(JSON.stringify(stale));
    const filter = { domain: 'Banking', role: 'Backend development', technology: 'Java' };
    const before = rows(db);
    assert.deepEqual(listJobs(db, filter).map(job => job.id), [10, 9, 8, 7, 6, 5, 1]);
    assert.deepEqual(listJobs(db, { ...filter, strict: true }).map(job => job.id), [1]);
    assert.equal(matchesClassification(before[10], filter, actual), false, 'Unclear in one dimension does not bypass another');
    assert.equal(listJobs(db, { strict: true }).length, 11, 'Strict alone is not a filter');
    for (const dimension of ['domain', 'role', 'technology'] as const) {
      assert.throws(() => validateClassificationFilter({ [dimension]: '__proto__' }, actual), /Invalid/);
      assert.throws(() => listJobs(db, { [dimension]: 'Not a label' }), /Invalid/);
    }
    const { command, values } = parseCliArgs(['list', '--domain', 'Banking', '--role', 'Backend development',
      '--technology', 'Java', '--strict', '--json', '--limit', '1']);
    assert.equal(command, 'list');
    assert.equal(values.strict, true);
    const output: string[] = [];
    t.mock.method(console, 'log', (text: string) => output.push(text));
    assert.equal(DB_COMMANDS.list(db, values), 0);
    const displayed = JSON.parse(output[0]) as Array<StoredJob & { classification: SavedJobClassification }>;
    assert.deepEqual(displayed.map(job => job.id), [1]);
    assert.equal(displayed[0].classification.decision.role.label, 'Backend development');
    assert.deepEqual(rows(db), before);
  });

  it('applies classification, SQL and predicate filters before LIMIT so late matches are reachable', t => {
    const actual = loadJobRubric();
    const db = fixture(t, 85);
    const batch = buildClassificationBatch(db, actual, 100, now);
    const input = review(batch, 'Backend development');
    for (const decision of input.decisions.slice(2)) decision.domain.label = 'Healthcare';
    saveClassificationBatch(db, input, batch, actual, now);
    db.prepare("UPDATE jobs SET status = 'saved' WHERE id = 1").run();
    const filter = { domain: 'Banking', role: 'Backend development', technology: 'Java', strict: true, limit: 1 };
    assert.equal(listJobs(db, { limit: 1 })[0].id, 85);
    assert.deepEqual(listJobs(db, filter).map(job => job.id), [2]);
    assert.deepEqual(listJobs(db, { ...filter, predicate: job => job.id === 1 }).map(job => job.id), [1]);
    assert.deepEqual(listJobs(db, { ...filter, status: 'saved', source: 'mycareersfuture', search: 'developer 0' })
      .map(job => job.id), [1]);
    assert.deepEqual(listJobs(db, { limit: 1, predicate: job => job.id === 1 }).map(job => job.id), [1]);
    assert.deepEqual(listJobs(db, { ...filter, status: 'rejected' }), []);
  });
});

describe('classify CLI artifact and database integration', () => {
  it('rejects hardlinked internal manifests before either export is written', t => {
    const { db, directory, artifacts, pendingPath, rubricPath } = cliFixture(t);
    fs.mkdirSync(artifacts, { recursive: true });
    const before = fs.readFileSync(rubricPath);
    for (const [command, manifest] of [
      ['classify', pendingPath], ['classifier', path.join(artifacts, 'pending-snapshot.json')],
    ]) {
      fs.linkSync(rubricPath, manifest);
      const out = path.join(directory, `${command}-source.json`);
      assert.throws(() => DB_COMMANDS[command](db, { out }), /without links/);
      assert.equal(fs.existsSync(out), false);
      assert.deepEqual(fs.readFileSync(rubricPath), before);
      fs.unlinkSync(manifest);
    }
  });

  it('rejects oversized decision and manifest files before database or audit writes', t => {
    const { db, directory, pendingPath } = cliFixture(t);
    DB_COMMANDS.classify(db, { limit: '3' });
    const batch = JSON.parse(fs.readFileSync(pendingPath, 'utf8')) as ClassificationBatch;
    const input = path.join(directory, 'large-input.json');
    fs.writeFileSync(input, JSON.stringify(review(batch, 'Backend development')));
    const original = fs.readFileSync(input);
    const before = rows(db);
    const out = path.join(directory, 'audit.json');
    for (const file of [input, pendingPath]) {
      fs.truncateSync(file, 16 * 1024 * 1024 + 1);
      assert.throws(() => DB_COMMANDS.classify(db, { input, out }), /16 MiB/);
      assert.deepEqual(rows(db), before);
      assert.equal(fs.existsSync(out), false);
      if (file === input) fs.writeFileSync(input, original);
    }
  });

  it('streams ordered filter scans without SQLite temporary sorting', t => {
    const db = fixture(t);
    for (const where of ['', "WHERE status = 'applied'", "WHERE source = 'mycareersfuture'",
      "WHERE status = 'applied' AND source = 'mycareersfuture'"]) {
      const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM jobs ${where}
        ORDER BY last_seen_at DESC, id DESC`).all() as Array<{ detail: string }>;
      assert.ok(plan.every(row => !/TEMP B-TREE/.test(row.detail)), JSON.stringify(plan));
    }
  });

  it('reserves the default source export path for exports even when absent during import', t => {
    const { db, directory, artifacts, pendingPath } = cliFixture(t);
    const sourcePath = path.join(artifacts, 'job-input.json');
    assert.equal(DB_COMMANDS.classify(db, { limit: '3', out: path.join(directory, 'custom-sources.json') }), 0);
    assert.equal(fs.existsSync(sourcePath), false);
    const batch = JSON.parse(fs.readFileSync(pendingPath, 'utf8')) as ClassificationBatch;
    const inputPath = path.join(directory, 'decisions.json');
    fs.writeFileSync(inputPath, JSON.stringify(review(batch, 'Backend development')));
    const before = rows(db);
    const pendingBytes = fs.readFileSync(pendingPath);
    const variants = process.platform === 'win32' ? [sourcePath, sourcePath.toUpperCase()] : [sourcePath];
    for (const out of variants) {
      assert.throws(() => DB_COMMANDS.classify(db, { input: inputPath, out }), /cannot overwrite/);
      assert.equal(fs.existsSync(sourcePath), false);
      assert.deepEqual(rows(db), before);
      assert.deepEqual(fs.readFileSync(pendingPath), pendingBytes);
    }
    const auditPath = path.join(directory, 'valid-audit.json');
    assert.equal(DB_COMMANDS.classify(db, { input: inputPath, out: auditPath }), 0);
    const auditBytes = fs.readFileSync(auditPath);
    assert.equal(DB_COMMANDS.classify(db, {}), 0);
    assert.ok(fs.existsSync(sourcePath));
    assert.deepEqual(fs.readFileSync(auditPath), auditBytes);
  });

  it('exports a custom output with an authoritative pending manifest and imports/replays into immutable audits', t => {
    const { db, directory, pendingPath, actualRubric } = cliFixture(t);
    const before = rows(db);
    const out = path.join(directory, 'custom', 'sources.json');
    const parsed = parseCliArgs(['classify', '--out', out, '--limit', '3']);
    assert.equal(parsed.command, 'classify');
    assert.equal(DB_COMMANDS.classify(db, parsed.values), 0);
    const batch = JSON.parse(fs.readFileSync(out, 'utf8')) as ClassificationBatch;
    assert.deepEqual(JSON.parse(fs.readFileSync(pendingPath, 'utf8')), batch);
    assert.deepEqual(batch.jobs.map(job => job.id), [1, 2, 3]);
    assert.deepEqual(rows(db), before);
    const input = review(batch, 'Backend development');
    const inputPath = path.join(directory, 'decisions.json');
    fs.writeFileSync(inputPath, JSON.stringify(input));
    const auditPath = path.join(directory, 'custom', 'audit.json');
    assert.equal(DB_COMMANDS.classify(db, { input: inputPath, out: auditPath }), 0);
    const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
    assert.equal(audit.updatedCount, 3);
    assert.equal(audit.preservedCount, 0);
    assert.deepEqual(audit.input, input);
    assert.deepEqual(audit.manifest, batch);
    const after = rows(db);
    assert.deepEqual(after.map(withoutClassification), before.map(withoutClassification));
    assert.ok(after.slice(0, 3).every(job => readJobClassification(job, actualRubric)));
    assert.deepEqual(after.slice(3), before.slice(3));
    assert.equal(DB_COMMANDS.classify(db, { input: inputPath, out: path.join(directory, 'replay.json') }), 0);
    assert.deepEqual(rows(db), after);
    const auditBytes = fs.readFileSync(auditPath);
    assert.throws(() => DB_COMMANDS.classify(db, { input: inputPath, out: auditPath }), /EEXIST/);
    assert.deepEqual(fs.readFileSync(auditPath), auditBytes);
    assert.deepEqual(rows(db), after);
    assert.deepEqual(buildClassificationBatch(db, actualRubric).jobs.map(job => job.id), [4, 5, 6]);
  });

  it('rejects custom --out database, sidecar, rubric, pending and audit collisions including hardlinks without writes', t => {
    const { db, directory, dbPath, rubricPath, artifacts, pendingPath } = cliFixture(t);
    const dbAlias = path.join(directory, 'db-alias.json');
    const rubricAlias = path.join(directory, 'rubric-alias.json');
    fs.linkSync(dbPath, dbAlias);
    fs.linkSync(rubricPath, rubricAlias);
    const protectedPaths = [dbPath, ...['-wal', '-shm', '-journal'].map(suffix => dbPath + suffix), rubricPath, pendingPath];
    const aliases = [dbAlias, rubricAlias];
    if (process.platform === 'win32') aliases.push(dbPath.toUpperCase(), rubricPath.toUpperCase());
    const before = rows(db);
    for (const out of [...protectedPaths, ...aliases]) {
      assert.throws(() => DB_COMMANDS.classify(db, { out }), /cannot overwrite/);
      assert.equal(fs.existsSync(artifacts), false);
      assert.deepEqual(rows(db), before);
    }
    assert.equal(DB_COMMANDS.classify(db, { limit: '3', out: path.join(directory, 'export.json') }), 0);
    const batch = JSON.parse(fs.readFileSync(pendingPath, 'utf8')) as ClassificationBatch;
    const inputPath = path.join(directory, 'decisions.json');
    fs.writeFileSync(inputPath, JSON.stringify(review(batch, 'Backend development')));
    const reserved = ['latest-review.json', 'pending-snapshot.json', 'review-2026-kept.json',
      'report-kept.md', 'classification-result-kept.json', 'pending-jobs-another-database.json']
      .map(file => path.join(artifacts, file));
    for (const file of reserved) fs.writeFileSync(file, 'Preserved artifact');
    const pendingAlias = path.join(directory, 'pending-alias.json');
    fs.linkSync(pendingPath, pendingAlias);
    const auditAlias = path.join(directory, 'audit-alias.json');
    fs.linkSync(reserved[2], auditAlias);
    const sidecarAlias = path.join(directory, 'wal-alias.json');
    fs.linkSync(dbPath + '-wal', sidecarAlias);
    const inputAlias = path.join(directory, 'input-alias.json');
    fs.linkSync(inputPath, inputAlias);
    const filesBefore = fs.readdirSync(artifacts).sort();
    const bytesBefore = new Map([...protectedPaths, ...reserved, inputPath].filter(file => fs.existsSync(file))
      .map(file => [file, fs.readFileSync(file)]));
    for (const out of [...protectedPaths, ...reserved, ...aliases, pendingAlias, auditAlias, sidecarAlias, inputPath, inputAlias, artifacts]) {
      assert.throws(() => DB_COMMANDS.classify(db, { input: inputPath, out }), /cannot overwrite/);
      assert.deepEqual(fs.readdirSync(artifacts).sort(), filesBefore);
      assert.deepEqual(rows(db), before);
    }
    for (const out of [pendingAlias, auditAlias, sidecarAlias, ...reserved]) {
      assert.throws(() => DB_COMMANDS.classify(db, { out }), /cannot overwrite/);
    }
    for (const [file, bytes] of bytesBefore) {
      if (file.endsWith('-shm')) {
        assert.equal(fs.statSync(file).size, bytes.length, 'SQLite reads may change SHM reader slots');
      } else {
        assert.deepEqual(fs.readFileSync(file), bytes, file);
      }
    }
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  });

  it('rolls back all classification updates on a real exclusive-write failure and an injected artifact failure', t => {
    const { db, directory, pendingPath } = cliFixture(t);
    assert.equal(DB_COMMANDS.classify(db, { limit: '3' }), 0);
    const batch = JSON.parse(fs.readFileSync(pendingPath, 'utf8')) as ClassificationBatch;
    const inputPath = path.join(directory, 'decisions.json');
    fs.writeFileSync(inputPath, JSON.stringify(review(batch, 'Backend development')));
    const out = path.join(directory, 'existing-audit.json');
    fs.writeFileSync(out, 'Do not replace');
    const before = rows(db);
    const pendingBefore = fs.readFileSync(pendingPath);
    assert.throws(() => DB_COMMANDS.classify(db, { input: inputPath, out }), /EEXIST/);
    assert.equal(fs.readFileSync(out, 'utf8'), 'Do not replace');
    assert.deepEqual(rows(db), before);
    const failingOut = path.join(directory, 'new-audit.json');
    const writeFileSync = fs.writeFileSync;
    let attempted = false;
    const mock = t.mock.method(fs, 'writeFileSync', ((file, ...args) => {
      if (typeof file === 'number') {
        attempted = true;
        assert.ok(rows(db).slice(0, 3).every(job => job.classification_json !== null),
          'The artifact failure occurs after DB writes inside the transaction');
        writeFileSync(file, 'Partial audit bytes');
        throw new Error('Injected artifact write failure');
      }
      return writeFileSync(file, ...args);
    }) as typeof fs.writeFileSync);
    try {
      assert.throws(() => DB_COMMANDS.classify(db, { input: inputPath, out: failingOut }), /Injected artifact write failure/);
    } finally {
      mock.mock.restore();
    }
    assert.equal(attempted, true);
    assert.equal(fs.existsSync(failingOut), false);
    assert.ok(fs.readdirSync(directory).every(file => !file.startsWith('.classification-audit-')));
    assert.deepEqual(rows(db), before);
    assert.deepEqual(fs.readFileSync(pendingPath), pendingBefore);
    assert.equal(DB_COMMANDS.classify(db, { input: inputPath, out: failingOut }), 0);
    assert.equal(JSON.parse(fs.readFileSync(failingOut, 'utf8')).updatedCount, 3);
  });

  it('rejects an import after a second export supersedes its manifest and keeps file identity stable across connections', t => {
    const { db, directory, dbPath, pendingPath } = cliFixture(t, 3);
    assert.equal(DB_COMMANDS.classify(db, { out: path.join(directory, 'first.json') }), 0);
    const first = JSON.parse(fs.readFileSync(pendingPath, 'utf8')) as ClassificationBatch;
    const inputPath = path.join(directory, 'decisions.json');
    fs.writeFileSync(inputPath, JSON.stringify(review(first, 'Backend development')));
    assert.equal(DB_COMMANDS.classify(db, { out: path.join(directory, 'second.json') }), 0);
    const secondBytes = fs.readFileSync(pendingPath);
    const second = JSON.parse(secondBytes.toString()) as ClassificationBatch;
    assert.notEqual(second.batchId, first.batchId);
    const before = rows(db);
    const rejectedOut = path.join(directory, 'rejected-audit.json');
    assert.throws(() => DB_COMMANDS.classify(db, { input: inputPath, out: rejectedOut }), /exported batch manifest/);
    assert.equal(fs.existsSync(rejectedOut), false);
    assert.deepEqual(fs.readFileSync(pendingPath), secondBytes);
    assert.deepEqual(rows(db), before);
    const connection = openDatabase(dbPath);
    try {
      assert.equal(classificationDatabaseId(connection), first.databaseId);
    } finally {
      connection.close();
    }
    const other = openDatabase(path.join(directory, 'other.db'));
    try {
      upsertJobs(other, Array.from({ length: 3 }, (_, index) => listing(index)));
      const otherBefore = rows(other);
      assert.notEqual(classificationDatabaseId(other), first.databaseId);
      assert.throws(() => saveClassificationBatch(other, review(first, 'Backend development'), first, loadJobRubric()),
        /database or rubric mismatch/);
      assert.deepEqual(rows(other), otherBefore);
    } finally {
      other.close();
    }
  });
});
