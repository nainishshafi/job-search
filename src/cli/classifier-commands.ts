import type Database from 'better-sqlite3';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { buildClassifierSnapshot, validateClassifierReview, type ClassifierRubric, type ClassifierSnapshot } from '../classifier.js';
import { buildClassificationBatch, classificationDatabaseId, loadJobRubric, saveClassificationBatch,
  type ClassificationBatch } from '../job-classification.js';
import { type CliValues, parsePositiveIntArg } from './args.js';

function canonical(file: string): string {
  let ancestor = path.resolve(file);
  const missing: string[] = [];
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error('Output path has no existing ancestor');
    missing.push(path.basename(ancestor));
    ancestor = parent;
  }
  const resolved = path.join(fs.realpathSync(ancestor), ...missing.reverse());
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
function sameFile(first: string, second: string): boolean {
  if (canonical(first) === canonical(second)) return true;
  if (!fs.existsSync(first) || !fs.existsSync(second)) return false;
  const firstStat = fs.statSync(first);
  const secondStat = fs.statSync(second);
  return firstStat.ino !== 0 && firstStat.ino === secondStat.ino && firstStat.dev === secondStat.dev;
}
function readClassificationJson(file: string): unknown {
  const maximumBytes = 16 * 1024 * 1024;
  // Read through the checked handle, retaining at most the limit plus one byte.
  const descriptor = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maximumBytes) throw new Error('Classification JSON must be a file of at most 16 MiB');
    const buffer = Buffer.alloc(Math.min(stat.size + 1, maximumBytes + 1));
    let count = 0;
    while (count < buffer.length) {
      const read = fs.readSync(descriptor, buffer, count, buffer.length - count, null);
      if (!read) break;
      count += read;
    }
    if (count > stat.size) throw new Error('Classification JSON changed while reading; retry with a stable file');
    return JSON.parse(buffer.toString('utf8', 0, count));
  } finally {
    fs.closeSync(descriptor);
  }
}
function assertUnaliasedDestination(file: string): void {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!stat.isFile() || stat.nlink > 1) {
    throw new Error('Classifier internal destination must be a regular file without links');
  }
}

export function handleClassify(db: Database.Database, values: CliValues): number {
  const rubric = loadJobRubric();
  const directory = path.resolve('data/classifier');
  const pendingPath = path.join(directory, `pending-jobs-${classificationDatabaseId(db)}.json`);
  const outPath = path.resolve(values.out ?? (values.input
    ? path.join(directory, `classification-result-${randomUUID()}.json`) : path.join(directory, 'job-input.json')));
  const protectedPaths = [path.resolve('config/job-classifier.json'), pendingPath];
  if (db.name && db.name !== ':memory:') protectedPaths.push(...['', '-wal', '-shm', '-journal'].map(suffix => path.resolve(db.name) + suffix));
  if (values.input) protectedPaths.push(path.resolve(values.input), path.join(directory, 'job-input.json'));
  if (fs.existsSync(directory)) protectedPaths.push(...fs.readdirSync(directory)
    .filter(file => file !== 'job-input.json').map(file => path.join(directory, file)));
  let stat: fs.Stats | undefined;
  try { stat = fs.lstatSync(outPath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (stat?.isSymbolicLink() && !fs.existsSync(outPath)) throw new Error('Output symlink target is missing');
  if (stat?.isDirectory() || protectedPaths.some(file => sameFile(outPath, file))) {
    throw new Error('Classification output cannot overwrite database, rubric, input or protected classifier artifacts');
  }
  const parsed = parsePositiveIntArg('limit', values.limit, 100);
  if (!parsed.ok) { console.error(parsed.error); return 1; }
  if (!values.input) {
    const batch = buildClassificationBatch(db, rubric, parsed.value ?? 40);
    assertUnaliasedDestination(pendingPath);
    fs.mkdirSync(directory, { recursive: true });
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(batch, null, 2));
    fs.writeFileSync(pendingPath, JSON.stringify(batch, null, 2));
    console.log(`Exported ${batch.jobs.length} pending jobs across all ages/statuses: ${outPath}`);
    console.log('The harness must classify these stored sources and import the complete batch with classify --input.');
    return 0;
  }
  const manifest = readClassificationJson(pendingPath) as ClassificationBatch;
  const input: unknown = readClassificationJson(values.input);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  // Artifact failure must roll back every database update as well.
  const stagedPath = path.join(path.dirname(outPath), `.classification-audit-${randomUUID()}.tmp`);
  let published = false;
  let result: ReturnType<typeof saveClassificationBatch>;
  try {
    result = db.transaction(() => {
      const result = saveClassificationBatch(db, input, manifest, rubric);
      const fd = fs.openSync(stagedPath, 'wx');
      try {
        fs.writeFileSync(fd, JSON.stringify({ ...result, input, manifest }, null, 2));
        fs.linkSync(stagedPath, outPath);
        published = true;
      } finally {
        try { fs.closeSync(fd); } finally { fs.unlinkSync(stagedPath); }
      }
      return result;
    })();
  } catch (error) {
    if (published) fs.unlinkSync(outPath);
    throw error;
  }
  console.log(`Saved ${result.updatedCount} job classifications; preserved ${result.preservedCount}. Audit: ${outPath}`);
  return 0;
}

export function handleClassifier(db: Database.Database, values: CliValues): number {
  const rubric = JSON.parse(fs.readFileSync(path.resolve('config/job-classifier.json'), 'utf8')) as ClassifierRubric;
  const directory = path.resolve('data/classifier');
  const latestPath = path.join(directory, 'latest-review.json');
  const pendingPath = path.join(directory, 'pending-snapshot.json');
  const outPath = values.out ? path.resolve(values.out) : undefined;
  if (outPath) {
    let outputLink: fs.Stats | undefined;
    try {
      outputLink = fs.lstatSync(outPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (outputLink?.isSymbolicLink() && !fs.existsSync(outPath)) {
      throw new Error('Output symlink target is missing');
    }
    const protectedPaths = [path.resolve('config/job-classifier.json'), values.input ? pendingPath : latestPath];
    if (db.name && db.name !== ':memory:') {
      protectedPaths.push(...['', '-wal', '-shm', '-journal'].map(suffix => path.resolve(db.name) + suffix));
    }
    if (fs.existsSync(directory)) {
      protectedPaths.push(...fs.readdirSync(directory)
        .filter(file => /^(review-\d.*\.json|report-.*\.md|pending-jobs-.*\.json|classification-result-.*\.json|job-input\.json)$/.test(file))
        .map(file => path.join(directory, file)));
    }
    if (protectedPaths.some(file => sameFile(outPath, file))) {
      throw new Error('Classifier output cannot overwrite the database, rubric or protected review artifacts');
    }
  }
  if (!values.input) {
    let previous: unknown;
    try {
      previous = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
    } catch {
      // Missing or unreadable prior state must permit a fresh review and repair.
    }
    const parsed = parsePositiveIntArg('limit', values.limit, 100);
    if (!parsed.ok) {
      console.error(parsed.error);
      return 1;
    }
    const snapshot = buildClassifierSnapshot(db, rubric, parsed.value ?? 40, new Date(), previous);
    const exportPath = outPath ?? path.join(directory, 'review-input.json');
    assertUnaliasedDestination(pendingPath);
    fs.mkdirSync(directory, { recursive: true });
    fs.mkdirSync(path.dirname(exportPath), { recursive: true });
    fs.writeFileSync(exportPath, JSON.stringify(snapshot, null, 2));
    fs.writeFileSync(pendingPath, JSON.stringify(snapshot, null, 2));
    console.log(`Exported ${snapshot.jobs.length} exemplars from ${snapshot.corpusCount} stored jobs: ${exportPath}`);
    console.log(`Classifier review due: ${snapshot.reviewDue}. The harness must make the decisions; database unchanged.`);
    return 0;
  }
  const input: unknown = JSON.parse(fs.readFileSync(values.input, 'utf8'));
  const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8')) as ClassifierSnapshot;
  const { review, snapshot } = db.transaction(() => {
    const review = validateClassifierReview(db, rubric, input, pending);
    if (Date.now() - Date.parse(review.snapshotAt) >= 7 * 86400000) {
      throw new Error('Export a fresh snapshot and review its sources; this review cycle is expired');
    }
    // Keep validation and audit sources on the same SQLite read snapshot.
    const snapshot = buildClassifierSnapshot(db, rubric, review.sampleLimit, new Date(review.snapshotAt));
    return { review, snapshot };
  })();
  const stamp = `${review.reviewedAt.replace(/[:.]/g, '-')}-${randomUUID()}`;
  fs.mkdirSync(directory, { recursive: true });
  const auditPath = path.join(directory, `review-${stamp}.json`);
  fs.writeFileSync(auditPath, JSON.stringify({ review, sourceSnapshot: snapshot }, null, 2), { flag: 'wx' });
  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    // Case variants, symlinks and hard links must not bypass the commit boundary.
    if (!sameFile(outPath, latestPath)) {
      fs.writeFileSync(outPath, JSON.stringify(review, null, 2));
    }
  }
  const clean = (text: string) => text.replace(/\\/g, '\\\\')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/([`*_[\]{}()])/g, '\\$1').replace(/[|\r\n]/g, ' ');
  const byId = new Map(snapshot.jobs.map((job) => [job.id, job]));
  const rows = review.decisions.map((decision) =>
    `| ${decision.id} | ${clean(byId.get(decision.id)!.title)} | ${clean(decision.domain.label)} | ${clean(decision.role.label)} | ${clean(decision.technology.labels.join(', '))} |`);
  const reportPath = path.join(directory, `report-${stamp}.md`);
  fs.writeFileSync(reportPath, [
    '# Harness job classifier review', '',
    `Rubric version ${review.rubricVersion}. Reviewed by ${clean(review.model)} at ${review.reviewedAt}.`,
    `Corpus: ${review.corpusCount} stored jobs. Detailed exemplar review: ${review.decisions.length} jobs.`,
    'These are acting-model judgments with validated source quotes, not independently verified accuracy measurements.',
    'Existing database project assessments, application statuses and company research were preserved.', '',
    '| ID | Job | Domain | Role | Technology |',
    '| --- | --- | --- | --- | --- |', ...rows, '',
    `Audit with source snapshots: ${path.basename(auditPath)}`,
    'Periodic reviews are checked during full harness workflows; no background schedule is installed.', '',
  ].join('\n'));
  // Commit completion only after every requested artifact has been written.
  const stagedLatest = path.join(directory, `.latest-${stamp}.tmp`);
  fs.writeFileSync(stagedLatest, JSON.stringify(review, null, 2), { flag: 'wx' });
  fs.renameSync(stagedLatest, latestPath);
  console.log(`Validated ${review.decisions.length} exemplar decisions from ${review.corpusCount} stored jobs.`);
  console.log(`Classifier examples saved: ${latestPath}`);
  console.log(`Classifier report: ${reportPath}`);
  return 0;
}
