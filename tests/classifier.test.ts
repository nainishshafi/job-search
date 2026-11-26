import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DB_COMMANDS } from '../src/cli/commands.js';
import {
  buildClassifierSnapshot, validateClassifierReview,
  type ClassifierReview, type ClassifierRubric, type ClassifierSnapshot,
} from '../src/classifier.js';
import { openDatabase, upsertJobs, type StoredJob } from '../src/db/client.js';
import { projectInputHash } from '../src/db/project-analysis.js';
import type { JobListing } from '../src/sources/types.js';

const rubric: ClassifierRubric = {
  version: 1,
  dimensions: {
    domain: { Government: 'Public sector work', Private: 'Private sector work', Unclear: 'Insufficient evidence' },
    role: { Developer: 'Software development', Unclear: 'Insufficient evidence' },
    technology: { TypeScript: 'TypeScript language', SQLite: 'SQLite database', Unclear: 'Insufficient evidence' },
  },
};
const now = new Date('2026-01-10T12:00:00.000Z');
function fixture(count = 6, dbPath = ':memory:') {
  const db = openDatabase(dbPath);
  upsertJobs(db, Array.from({ length: count }, (_, i): JobListing => ({
    source: 'mycareersfuture', externalId: `classifier-${i}`, url: `https://example.test/${i}`,
    title: `Developer ${i}`, company: 'Example company', location: 'Singapore',
    salaryMin: null, salaryMax: null, salaryCurrency: 'SGD', salaryInterval: null,
    employmentType: null, descriptionSnippet: 'Build TypeScript services using SQLite.',
    skills: [], postedAt: '2020-01-01',
  })));
  db.prepare(`UPDATE jobs SET project_type = CASE WHEN id % 2 = 0 THEN 'Private' ELSE 'Government' END,
    project_reasoning = 'Legacy example, not ground truth', status = 'applied', notes = 'Preserve me'`).run();
  return db;
}
type ReviewInput = Omit<ClassifierReview, 'reviewedAt'>;
function review(snapshot: ClassifierSnapshot): ReviewInput {
  return {
    snapshotAt: snapshot.snapshotAt, sampleLimit: snapshot.sampleLimit, sampleSeed: snapshot.sampleSeed,
    rubricVersion: snapshot.rubricVersion, rubricHash: snapshot.rubricHash,
    corpusCount: snapshot.corpusCount, model: 'harness-test-model',
    decisions: snapshot.jobs.map((job) => ({
      id: job.id, input_hash: job.input_hash,
      domain: { label: 'Private', score: 61, evidence: job.company, reasoning: 'Test-supplied assessment.' },
      role: { label: 'Developer', score: 90, evidence: job.title, reasoning: 'Test-supplied assessment.' },
      technology: {
        labels: ['TypeScript', 'SQLite'], score: 80,
        evidence: 'TypeScript services using SQLite', reasoning: 'Test-supplied assessment.',
      },
    })),
  };
}
function changed(input: ReviewInput, change: (value: ReviewInput) => void): ReviewInput {
  const copy = structuredClone(input);
  change(copy);
  return copy;
}

describe('harness classifier snapshots', () => {
  it('reads the whole corpus and exports bounded, diverse, deterministic source examples without writes', (t) => {
    const db = fixture(503);
    t.after(() => db.close());
    db.prepare("UPDATE jobs SET project_type = '__proto__' WHERE id = 503").run();
    db.prepare('UPDATE jobs SET project_type = NULL, description_snippet = NULL WHERE id = 502').run();
    const before = db.prepare('SELECT * FROM jobs ORDER BY id').all();
    const snapshot = buildClassifierSnapshot(db, rubric, 40, now);
    assert.equal(snapshot.corpusCount, 503);
    assert.equal(snapshot.jobs.length, 40);
    assert.equal(snapshot.reviewDue, true);
    assert.equal(snapshot.existingDomainCounts.__proto__, 1);
    assert.equal(Object.getPrototypeOf(snapshot.existingDomainCounts), null);
    assert.equal(Object.values(snapshot.existingDomainCounts).reduce((a, b) => a + b, 0), 503);
    assert.deepEqual(new Set(snapshot.jobs.slice(0, 4).map((job) => job.previousDomain)),
      new Set(['Government', 'Private', null, '__proto__']));
    const stored = db.prepare('SELECT * FROM jobs WHERE id = ?').get(snapshot.jobs[0].id) as StoredJob;
    assert.equal(snapshot.jobs[0].input_hash, projectInputHash(stored));
    assert.equal(snapshot.jobs[0].previousReasoning, 'Legacy example, not ground truth');
    assert.equal(snapshot.jobs.find((job) => job.id === 502)?.description, null);
    assert.deepEqual(buildClassifierSnapshot(db, rubric, 40, now), snapshot);
    assert.equal(buildClassifierSnapshot(db, rubric, undefined, now).jobs.length, 40);
    assert.deepEqual(db.prepare('SELECT * FROM jobs ORDER BY id').all(), before);
  });

  it('rotates groups by UTC day without depending on a previous review and replays the original sample', (t) => {
    const db = fixture(20);
    t.after(() => db.close());
    const snapshot = buildClassifierSnapshot(db, rubric, 4, now);
    const validated = validateClassifierReview(db, rubric, review(snapshot));
    const tomorrow = new Date(now.getTime() + 86400000);
    const rotated = buildClassifierSnapshot(db, rubric, 4, tomorrow);
    assert.notDeepEqual(rotated.jobs.map((job) => job.id), snapshot.jobs.map((job) => job.id));
    assert.deepEqual(
      buildClassifierSnapshot(db, rubric, 4, tomorrow, validated).jobs,
      rotated.jobs,
    );
    assert.deepEqual(validateClassifierReview(db, rubric, validated).decisions, validated.decisions);
    assert.deepEqual(
      buildClassifierSnapshot(db, rubric, 4, new Date('2026-01-10T23:59:59.000Z')).jobs,
      snapshot.jobs,
    );
  });

  it('reserves Unclear examples and spreads truncated rounds across late alphabetic groups', (t) => {
    const db = fixture(180);
    t.after(() => db.close());
    const update = db.prepare('UPDATE jobs SET project_type = ? WHERE id = ?');
    for (let id = 1; id <= 180; id++) {
      update.run(id <= 80 ? 'Unclear' : `Sector ${String(id - 81).padStart(3, '0')}`, id);
    }
    const snapshot = buildClassifierSnapshot(db, rubric, 40, now);
    assert.equal(snapshot.jobs.length, 40);
    assert.equal(snapshot.jobs.filter((job) => job.previousDomain === 'Unclear').length, 8);
    const sectors = snapshot.jobs.filter((job) => job.previousDomain !== 'Unclear');
    assert.equal(new Set(sectors.map((job) => job.previousDomain)).size, 32);
    assert.ok(sectors.some((job) => job.previousDomain! >= 'Sector 090'));
    assert.ok(sectors.some((job) => job.previousDomain! < 'Sector 010'));
    for (let range = 0; range < 10; range++) {
      assert.ok(sectors.some((job) => Number(job.previousDomain!.slice(7)) >= range * 10 &&
        Number(job.previousDomain!.slice(7)) < (range + 1) * 10));
    }
    assert.deepEqual(buildClassifierSnapshot(db, rubric, 40, now).jobs, snapshot.jobs);
    const tomorrow = buildClassifierSnapshot(db, rubric, 40, new Date(+now + 86400000));
    assert.notDeepEqual(tomorrow.jobs.map((job) => job.id), snapshot.jobs.map((job) => job.id));
    const validated = validateClassifierReview(db, rubric, review(snapshot));
    assert.deepEqual(validateClassifierReview(db, rubric, validated).decisions, validated.decisions);
    assert.equal(buildClassifierSnapshot(db, rubric, 40, new Date(validated.reviewedAt), validated).reviewDue, true);
  });

  it('includes late government, healthcare and manufacturing groups when all groups fit', (t) => {
    const db = fixture(100);
    t.after(() => db.close());
    const labels = ['Unclear', 'A Consulting', 'B Banking', 'C Commerce',
      'Government / public sector', 'Manufacturing', 'Public healthcare'];
    const update = db.prepare('UPDATE jobs SET project_type = ? WHERE id = ?');
    for (let id = 1; id <= 100; id++) update.run(id <= 58 ? 'Unclear' : labels[1 + id % 6], id);
    const snapshot = buildClassifierSnapshot(db, rubric, 40, now);
    assert.deepEqual(new Set(snapshot.jobs.map((job) => job.previousDomain)), new Set(labels));
    assert.equal(snapshot.jobs.filter((job) => job.previousDomain === 'Unclear').length, 8);
    assert.equal(new Set(snapshot.jobs.map((job) => job.id)).size, 40);
    db.prepare("UPDATE jobs SET project_type = 'Unclear'").run();
    const onlyUnclear = buildClassifierSnapshot(db, rubric, 40, now);
    assert.equal(onlyUnclear.jobs.length, 40);
    assert.equal(new Set(onlyUnclear.jobs.map((job) => job.id)).size, 40);
    db.prepare("UPDATE jobs SET project_type = 'Private' WHERE id > 1").run();
    assert.equal(buildClassifierSnapshot(db, rubric, 40, now).jobs.filter((job) => job.previousDomain === 'Unclear').length, 1);
  });

  it('canonicalizes rubric keys and invalidates reviews on version or definition changes', (t) => {
    const db = fixture();
    t.after(() => db.close());
    const snapshot = buildClassifierSnapshot(db, rubric, 4, now);
    const validated = validateClassifierReview(db, rubric, review(snapshot));
    const reordered = structuredClone(rubric);
    reordered.dimensions.domain = Object.fromEntries(Object.entries(rubric.dimensions.domain).reverse());
    assert.equal(buildClassifierSnapshot(db, reordered, 4, now).rubricHash, snapshot.rubricHash);
    for (const altered of [
      { ...rubric, version: 2 },
      { ...rubric, dimensions: { ...rubric.dimensions, domain: { ...rubric.dimensions.domain, Private: 'New definition' } } },
    ]) {
      assert.throws(() => validateClassifierReview(db, altered, validated), /rubric/);
      assert.equal(buildClassifierSnapshot(db, altered, 4, new Date(), validated).reviewDue, true);
    }
  });

  it('marks missing, malformed, changed-source and seven-day-old reviews due', (t) => {
    const db = fixture(20);
    t.after(() => db.close());
    const snapshot = buildClassifierSnapshot(db, rubric, 4, new Date());
    const validated = validateClassifierReview(db, rubric, review(snapshot));
    const reviewedAt = new Date(validated.reviewedAt);
    assert.equal(buildClassifierSnapshot(db, rubric, 4, reviewedAt, validated).reviewDue, false);
    const cycleStartedAt = Date.parse(snapshot.snapshotAt);
    assert.equal(buildClassifierSnapshot(db, rubric, 4, new Date(cycleStartedAt + 7 * 86400000 - 1), validated).reviewDue, false);
    assert.equal(buildClassifierSnapshot(db, rubric, 4, new Date(cycleStartedAt + 7 * 86400000), validated).reviewDue, true);
    const historical = review(buildClassifierSnapshot(db, rubric, 4, new Date(cycleStartedAt - 10 * 86400000)));
    const reimported = validateClassifierReview(db, rubric, historical);
    assert.equal(buildClassifierSnapshot(db, rubric, 4, new Date(reimported.reviewedAt), reimported).reviewDue, true);
    for (const previous of [undefined, null, [], {}, review(snapshot), { ...validated, reviewedAt: 'invalid' },
      { ...validated, reviewedAt: '2999-01-01T00:00:00.000Z' }, { ...validated, reviewedAt: '2020-01-01T00:00:00.000Z' }]) {
      assert.equal(buildClassifierSnapshot(db, rubric, 4, reviewedAt, previous).reviewDue, true);
    }
    db.prepare('UPDATE jobs SET title = ? WHERE id = ?').run('Changed title', snapshot.jobs[0].id);
    assert.equal(buildClassifierSnapshot(db, rubric, 4, reviewedAt, validated).reviewDue, true);
    assert.throws(() => validateClassifierReview(db, rubric, validated), /changed source hash/);
  });
});

describe('harness classifier review validation', () => {
  it('rejects database, rubric and reserved artifact output collisions before any writes', async () => {
    const originalCwd = process.cwd();
    const directory = fs.mkdtempSync(path.join(originalCwd, 'data', 'classifier-test-'));
    const dbPath = path.join(directory, 'jobs.db');
    const db = fixture(6, dbPath);
    try {
      fs.mkdirSync(path.join(directory, 'config'));
      const rubricPath = path.join(directory, 'config', 'job-classifier.json');
      fs.writeFileSync(rubricPath, JSON.stringify(rubric));
      process.chdir(directory);
      const protectedFiles = [dbPath, ...['-wal', '-shm', '-journal'].map(suffix => dbPath + suffix), rubricPath];
      const dbAlias = path.join(directory, 'db-alias.json');
      const rubricAlias = path.join(directory, 'rubric-alias.json');
      fs.linkSync(dbPath, dbAlias);
      fs.linkSync(rubricPath, rubricAlias);
      const aliases = [dbAlias, rubricAlias];
      if (process.platform === 'win32') aliases.push(dbPath.toUpperCase(), rubricPath.toUpperCase());
      const bytesBefore = new Map(protectedFiles.filter(file => fs.existsSync(file))
        .map(file => [file, fs.readFileSync(file)]));
      const rowsBefore = db.prepare('SELECT * FROM jobs ORDER BY id').all();
      const latestPath = path.join(directory, 'data', 'classifier', 'latest-review.json');
      for (const out of [...protectedFiles, ...aliases, latestPath]) {
        await assert.rejects(async () => DB_COMMANDS.classifier(db, { out }), /cannot overwrite/);
        assert.equal(fs.existsSync(path.join(directory, 'data', 'classifier')), false);
      }
      assert.equal(await DB_COMMANDS.classifier(db, { limit: '4' }), 0);
      const snapshot = JSON.parse(fs.readFileSync('data/classifier/review-input.json', 'utf8')) as ClassifierSnapshot;
      const inputPath = path.join(directory, 'decisions.json');
      fs.writeFileSync(inputPath, JSON.stringify(review(snapshot)));
      const auditPath = path.join(directory, 'data', 'classifier', 'review-2026-preserved.json');
      fs.writeFileSync(auditPath, 'Immutable source audit');
      const auditAlias = path.join(directory, 'audit-alias.json');
      fs.linkSync(auditPath, auditAlias);
      const pendingPath = path.join(directory, 'data', 'classifier', 'pending-snapshot.json');
      const pendingBefore = fs.readFileSync(pendingPath);
      const filesBefore = fs.readdirSync('data/classifier').sort();
      for (const out of [...protectedFiles, ...aliases, pendingPath, auditPath, auditAlias]) {
        await assert.rejects(async () => DB_COMMANDS.classifier(db, { input: inputPath, out }), /cannot overwrite/);
        assert.deepEqual(fs.readdirSync('data/classifier').sort(), filesBefore);
      }
      await assert.rejects(async () => DB_COMMANDS.classifier(db, { out: auditAlias }), /cannot overwrite/);
      for (const [file, bytes] of bytesBefore) {
        const current = fs.readFileSync(file);
        if (file.endsWith('-shm')) {
          // SQLite reads can update shared-memory reader slots without changing stored data.
          assert.equal(current.length, bytes.length);
        } else {
          assert.ok(current.equals(bytes), `Protected file changed: ${file}`);
        }
      }
      assert.deepEqual(fs.readFileSync(pendingPath), pendingBefore);
      assert.equal(fs.readFileSync(auditPath, 'utf8'), 'Immutable source audit');
      assert.deepEqual(db.prepare('SELECT * FROM jobs ORDER BY id').all(), rowsBefore);
      assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
      assert.equal(await DB_COMMANDS.classifier(db, {
        input: inputPath, out: path.join(directory, 'new', 'nested', 'review.json'),
      }), 0);
    } finally {
      process.chdir(originalCwd);
      db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('repairs malformed latest JSON through the CLI while rejecting invalid imports before writes', async (t) => {
    const originalCwd = process.cwd();
    const directory = fs.mkdtempSync(path.join(originalCwd, 'data', 'classifier-test-'));
    const db = fixture();
    db.prepare('UPDATE jobs SET title = ?').run('Developer <img src=x onerror=alert(1)> [open](javascript:alert(1))');
    const before = db.prepare('SELECT * FROM jobs ORDER BY id').all();
    try {
      fs.mkdirSync(path.join(directory, 'config'));
      fs.writeFileSync(path.join(directory, 'config', 'job-classifier.json'), JSON.stringify(rubric));
      fs.mkdirSync(path.join(directory, 'data', 'classifier'), { recursive: true });
      const latestPath = path.join(directory, 'data', 'classifier', 'latest-review.json');
      fs.writeFileSync(latestPath, '{broken JSON');
      process.chdir(directory);
      assert.equal(await DB_COMMANDS.classifier(db, { limit: '4' }), 0);
      const snapshot = JSON.parse(fs.readFileSync('data/classifier/review-input.json', 'utf8')) as ClassifierSnapshot;
      assert.equal(snapshot.reviewDue, true);
      const inputPath = path.join(directory, 'decisions.json');
      const input = review(snapshot);
      fs.writeFileSync(inputPath, JSON.stringify({ ...input, decisions: input.decisions.slice(1) }));
      const filesBefore = fs.readdirSync('data/classifier').sort();
      await assert.rejects(async () => DB_COMMANDS.classifier(db, { input: inputPath }), /exact sample/);
      assert.deepEqual(fs.readdirSync('data/classifier').sort(), filesBefore);
      assert.equal(fs.readFileSync(latestPath, 'utf8'), '{broken JSON');
      fs.writeFileSync(inputPath, JSON.stringify({ ...input, sampleLimit: 1, decisions: input.decisions.slice(0, 1) }));
      await assert.rejects(async () => DB_COMMANDS.classifier(db, { input: inputPath }), /exported snapshot/);
      assert.deepEqual(fs.readdirSync('data/classifier').sort(), filesBefore);
      const historical = buildClassifierSnapshot(db, rubric, 4, new Date(Date.now() - 10 * 86400000));
      fs.writeFileSync('data/classifier/pending-snapshot.json', JSON.stringify(historical));
      fs.writeFileSync(inputPath, JSON.stringify(review(historical)));
      await assert.rejects(async () => DB_COMMANDS.classifier(db, { input: inputPath }), /expired/);
      assert.equal(fs.readFileSync(latestPath, 'utf8'), '{broken JSON');
      fs.writeFileSync('data/classifier/pending-snapshot.json', JSON.stringify(snapshot));
      fs.writeFileSync(inputPath, JSON.stringify(input));
      await assert.rejects(async () => DB_COMMANDS.classifier(db, {
        input: inputPath, out: path.join(directory, 'config'),
      }));
      assert.equal(fs.readFileSync(latestPath, 'utf8'), '{broken JSON');
      const hardLinkPath = path.join(directory, 'latest-alias.json');
      fs.linkSync(latestPath, hardLinkPath);
      const writeFileSync = fs.writeFileSync;
      const writeMock = t.mock.method(fs, 'writeFileSync', ((file, ...args) => {
        if (String(file).endsWith('.md')) throw new Error('Simulated report failure');
        return writeFileSync(file, ...args);
      }) as typeof fs.writeFileSync);
      try {
        const aliases = [latestPath, hardLinkPath];
        if (process.platform === 'win32') aliases.push(latestPath.toUpperCase());
        for (const alias of aliases) {
          await assert.rejects(async () => DB_COMMANDS.classifier(db, {
            input: inputPath, out: alias,
          }), /Simulated report failure/);
          assert.equal(fs.readFileSync(latestPath, 'utf8'), '{broken JSON');
        }
        fs.unlinkSync(latestPath);
        const danglingPath = path.join(directory, 'dangling-latest.json');
        const lstatSync = fs.lstatSync;
        let restoreLstat = () => {};
        try {
          try {
            fs.symlinkSync(latestPath, danglingPath, 'file');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
            // Windows without symlink privilege: exercise the same lstat/exists contract.
            const lstatMock = t.mock.method(fs, 'lstatSync', ((file, ...args) => String(file) === danglingPath ?
              { isSymbolicLink: () => true } : lstatSync(file, ...args)) as typeof fs.lstatSync);
            restoreLstat = () => lstatMock.mock.restore();
          }
          await assert.rejects(async () => DB_COMMANDS.classifier(db, {
            input: inputPath, out: danglingPath,
          }), /symlink target is missing/);
          assert.equal(fs.existsSync(latestPath), false);
        } finally {
          restoreLstat();
          writeFileSync(latestPath, '{broken JSON');
        }
      } finally {
        writeMock.mock.restore();
      }
      assert.equal(await DB_COMMANDS.classifier(db, { input: inputPath }), 0);
      const persisted = JSON.parse(fs.readFileSync(latestPath, 'utf8')) as ClassifierReview;
      assert.equal(persisted.decisions.length, 4);
      const auditFile = fs.readdirSync('data/classifier').find(file =>
        /^review-.*\.json$/.test(file) && file !== 'review-input.json' &&
        JSON.parse(fs.readFileSync(path.join('data/classifier', file), 'utf8')).review.reviewedAt === persisted.reviewedAt)!;
      const audit = JSON.parse(fs.readFileSync(path.join('data/classifier', auditFile), 'utf8'));
      assert.deepEqual(audit.review, persisted);
      assert.deepEqual(audit.sourceSnapshot.jobs, snapshot.jobs);
      const reportFile = fs.readdirSync('data/classifier').find(file => /^report-.*\.md$/.test(file))!;
      const reportText = fs.readFileSync(path.join('data/classifier', reportFile), 'utf8');
      assert.ok(reportText.includes('&lt;img src=x onerror=alert\\(1\\)&gt;'));
      assert.ok(reportText.includes('\\[open\\]\\(javascript:alert\\(1\\)\\)'));
      assert.ok(!reportText.includes('<img'));
      assert.equal(await DB_COMMANDS.classifier(db, { limit: '4' }), 0);
      assert.equal(JSON.parse(fs.readFileSync('data/classifier/review-input.json', 'utf8')).reviewDue, false);
      assert.deepEqual(db.prepare('SELECT * FROM jobs ORDER BY id').all(), before);
    } finally {
      process.chdir(originalCwd);
      db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('returns a typed detached review with generated reviewedAt and preserves all database rows', (t) => {
    const db = fixture();
    t.after(() => db.close());
    const input = review(buildClassifierSnapshot(db, rubric, 4, now));
    const before = db.prepare('SELECT * FROM jobs ORDER BY id').all();
    const start = Date.now();
    const validated = validateClassifierReview(db, rubric, { ...input, reviewedAt: 'spoofed', unrelated: 'ignored' });
    assert.ok(Date.parse(validated.reviewedAt) >= start && Date.parse(validated.reviewedAt) <= Date.now());
    assert.deepEqual(validated.decisions, input.decisions);
    assert.deepEqual(db.prepare('SELECT * FROM jobs ORDER BY id').all(), before);
    input.decisions[0].technology.labels.push('Unclear');
    assert.deepEqual(validated.decisions[0].technology.labels, ['TypeScript', 'SQLite']);
  });

  it('requires exact sample coverage and unchanged source hashes and corpus size', (t) => {
    const db = fixture(20);
    t.after(() => db.close());
    const snapshot = buildClassifierSnapshot(db, rubric, 4, now);
    const input = review(snapshot);
    assert.throws(() => validateClassifierReview(db, rubric, { ...input, decisions: input.decisions.slice(1) }), /exact sample/);
    assert.throws(() => validateClassifierReview(db, rubric, { ...input, decisions: [...input.decisions, input.decisions[0]] }), /exact sample/);
    assert.throws(() => validateClassifierReview(db, rubric,
      changed(input, (r) => r.decisions[0] = r.decisions[1])), /Duplicate/);
    assert.throws(() => validateClassifierReview(db, rubric, { ...input, decisions: Array(4) }), /exact sample/);
    assert.throws(() => validateClassifierReview(db, rubric, changed(input, (r) => r.decisions[0].id = 99999)), /out-of-sample/);
    assert.throws(() => validateClassifierReview(db, rubric, changed(input, (r) => r.decisions[0].input_hash = 'fake')), /hash/);
    assert.throws(() => validateClassifierReview(db, rubric, { ...input, corpusCount: 19 }), /corpus/);
    assert.throws(() => validateClassifierReview(db, rubric, { ...input, sampleSeed: '2026-01-11T12:00:00.000Z' }), /seed/);
    const reversed = { ...input, decisions: [...input.decisions].reverse() };
    assert.equal(validateClassifierReview(db, rubric, reversed).decisions.length, 4);
    db.prepare("INSERT INTO jobs (source, external_id, url, title, company, location) VALUES (?, ?, ?, ?, ?, ?)").run(
      'mycareersfuture', 'new', 'https://example.test/new', 'New developer', 'Example company', 'Singapore');
    assert.throws(() => validateClassifierReview(db, rubric, input), /corpus/);
  });

  it('requires contiguous exact evidence from an individual source field for every dimension', (t) => {
    const db = fixture();
    t.after(() => db.close());
    const input = review(buildClassifierSnapshot(db, rubric, 4, now));
    for (const dimension of ['domain', 'role', 'technology'] as const) {
      for (const evidence of ['', ' ', 'typescript', 'TypeScript SQLite', 'Developer 1 Example company']) {
        assert.throws(() => validateClassifierReview(db, rubric,
          changed(input, (r) => r.decisions[0][dimension].evidence = evidence)), /string|quote/);
      }
    }
  });

  it('enforces known labels, integer scores and exclusive null-scored Unclear', (t) => {
    const db = fixture();
    t.after(() => db.close());
    const input = review(buildClassifierSnapshot(db, rubric, 4, now));
    for (const dimension of ['domain', 'role'] as const) {
      for (const label of ['Unknown', '__proto__', 'constructor']) {
        assert.throws(() => validateClassifierReview(db, rubric,
          changed(input, (r) => r.decisions[0][dimension].label = label)), /labels/);
      }
      for (const score of [-1, 101, 1.5, NaN, null]) {
        assert.throws(() => validateClassifierReview(db, rubric,
          changed(input, (r) => r.decisions[0][dimension].score = score)), /score/);
      }
      assert.throws(() => validateClassifierReview(db, rubric,
        changed(input, (r) => r.decisions[0][dimension].label = 'Unclear')), /score/);
    }
    for (const labels of [[], Array<string>(1), ['TypeScript', 'TypeScript'], ['Unknown'], ['Unclear', 'TypeScript'], ['__proto__']]) {
      assert.throws(() => validateClassifierReview(db, rubric,
        changed(input, (r) => r.decisions[0].technology.labels = labels)), /labels/);
    }
    for (const score of [-1, 101, 1.5, null]) {
      assert.throws(() => validateClassifierReview(db, rubric,
        changed(input, (r) => r.decisions[0].technology.score = score)), /score/);
    }
    const unclear = changed(input, (r) => {
      r.decisions[0].domain = { ...r.decisions[0].domain, label: 'Unclear', score: null };
      r.decisions[0].role = { ...r.decisions[0].role, label: 'Unclear', score: null };
      r.decisions[0].technology = { ...r.decisions[0].technology, labels: ['Unclear'], score: null };
    });
    assert.equal(validateClassifierReview(db, rubric, unclear).decisions[0].technology.score, null);
    assert.throws(() => validateClassifierReview(db, rubric,
      changed(unclear, (r) => r.decisions[0].technology.labels.push('TypeScript'))), /mixed Unclear/);
    assert.throws(() => validateClassifierReview(db, rubric,
      changed(unclear, (r) => r.decisions[0].technology.score = 0)), /score/);
    for (const score of [0, 100]) {
      assert.equal(validateClassifierReview(db, rubric,
        changed(input, (r) => r.decisions[0].technology.score = score)).decisions[0].technology.score, score);
    }
  });

  it('rejects malformed objects, metadata, dimension fields and rubric definitions cleanly', (t) => {
    const db = fixture();
    t.after(() => db.close());
    const input = review(buildClassifierSnapshot(db, rubric, 4, now));
    const invalid: unknown[] = [null, [], 'review', {}, ...[null, [], 'decision'].map((decision) =>
      ({ ...input, decisions: [decision] }))];
    for (const field of ['domain', 'role', 'technology']) {
      for (const value of [null, [], 'dimension', {}]) {
        invalid.push({ ...input, decisions: [{ ...input.decisions[0], [field]: value }, ...input.decisions.slice(1)] });
      }
    }
    for (const [key, values] of Object.entries({
      model: ['', ' ', null, {}, []], snapshotAt: ['invalid', '2026-02-30T00:00:00.000Z', '2999-01-01T00:00:00.000Z', null],
      sampleLimit: [null, 0, -1, 1.5, '4', {}], decisions: [null, {}], rubricVersion: [2, '1'], rubricHash: ['bad', null],
    })) {
      invalid.push(...values.map((value) => ({ ...input, [key]: value })));
    }
    for (const value of invalid) {
      assert.throws(() => validateClassifierReview(db, rubric, value), (error: unknown) =>
        error instanceof Error && !(error instanceof TypeError));
    }
    for (const value of [null, [], {}, { version: 1, dimensions: null },
      { ...rubric, dimensions: { ...rubric.dimensions, domain: [] } },
      { ...rubric, dimensions: { ...rubric.dimensions, domain: { Government: 'Definition' } } }]) {
      assert.throws(() => buildClassifierSnapshot(db, value as ClassifierRubric, 4, now));
    }
    for (const limit of [0, -1, 1.5, Infinity]) assert.throws(() => buildClassifierSnapshot(db, rubric, limit, now));
  });

  it('supports an empty corpus and defaults replay metadata to forty for standard harness inputs', (t) => {
    const db = openDatabase(':memory:');
    t.after(() => db.close());
    const snapshot = buildClassifierSnapshot(db, rubric, 40, now);
    assert.equal(snapshot.corpusCount, 0);
    assert.deepEqual(snapshot.jobs, []);
    const { sampleLimit, sampleSeed, ...input } = review(snapshot);
    assert.equal(validateClassifierReview(db, rubric, input).sampleLimit, 40);
    assert.equal(validateClassifierReview(db, rubric, input).sampleSeed, snapshot.snapshotAt);
    assert.throws(() => validateClassifierReview(db, rubric, { ...input, decisions: Array(1) }), /exact sample/);
  });
});
