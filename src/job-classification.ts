import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { rubricHash, validateDimension, type ClassifierRubric, type ClassifierDecision } from './classifier.js';
import type { StoredJob } from './db/client.js';
import { projectInputHash } from './db/project-analysis.js';

export interface ClassificationFilter {
  domain?: string;
  role?: string;
  technology?: string;
  strict?: boolean;
}
export interface SavedJobClassification {
  schemaVersion: 1;
  rubricVersion: number;
  rubricHash: string;
  input_hash: string;
  model: string;
  classifiedAt: string;
  decision: ClassifierDecision;
}
export interface ClassificationBatch {
  workflow: 'job-classification';
  schemaVersion: 1;
  batchId: string;
  databaseId: string;
  snapshotAt: string;
  rubricVersion: number;
  rubricHash: string;
  jobs: Array<{ id: number; input_hash: string; title: string; company: string; description: string | null }>;
}
const memoryIdentities = new WeakMap<Database.Database, string>();
export function classificationDatabaseId(db: Database.Database): string {
  if (!db.name || db.name === ':memory:') {
    if (!memoryIdentities.has(db)) memoryIdentities.set(db, randomUUID());
    return memoryIdentities.get(db)!;
  }
  const file = fs.realpathSync(db.name);
  const stat = fs.statSync(file);
  return createHash('sha256').update(JSON.stringify([
    process.platform === 'win32' ? file.toLowerCase() : file, stat.dev, stat.ino,
  ])).digest('hex');
}
export function loadJobRubric(): ClassifierRubric {
  const rubric = JSON.parse(fs.readFileSync(path.resolve('config/job-classifier.json'), 'utf8')) as ClassifierRubric;
  rubricHash(rubric);
  return rubric;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected classification object');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Expected nonempty classification text');
  return value;
}
function iso(value: unknown, now: Date): string {
  const string = text(value);
  const date = new Date(string);
  if (!Number.isFinite(+date) || date.toISOString() !== string || date > now) {
    throw new Error('Invalid or future classification timestamp');
  }
  return string;
}
function decisionFor(value: unknown, job: StoredJob, rubric: ClassifierRubric): ClassifierDecision {
  const input = object(value);
  if (input.id !== job.id || input.input_hash !== projectInputHash(job)) throw new Error('Changed classification source hash or job ID');
  const domain = validateDimension(input.domain, rubric.dimensions.domain, job, false);
  const role = validateDimension(input.role, rubric.dimensions.role, job, false);
  const technology = validateDimension(input.technology, rubric.dimensions.technology, job, true);
  return {
    id: job.id, input_hash: projectInputHash(job),
    domain: { label: domain.labels[0], score: domain.score, evidence: domain.evidence, reasoning: domain.reasoning },
    role: { label: role.labels[0], score: role.score, evidence: role.evidence, reasoning: role.reasoning },
    technology,
  };
}
/** Missing, malformed and outdated decisions are pending; completed Unclear remains valid. */
export function readJobClassification(
  job: StoredJob, rubric: ClassifierRubric = loadJobRubric(), now = new Date(),
): SavedJobClassification | null {
  try {
    const value = object(JSON.parse(job.classification_json ?? 'null'));
    const hash = projectInputHash(job);
    if (value.schemaVersion !== 1 || value.rubricVersion !== rubric.version ||
      value.rubricHash !== rubricHash(rubric) || value.input_hash !== hash) return null;
    return {
      schemaVersion: 1, rubricVersion: rubric.version, rubricHash: value.rubricHash as string,
      input_hash: hash, model: text(value.model), classifiedAt: iso(value.classifiedAt, now),
      decision: decisionFor(value.decision, job, rubric),
    };
  } catch {
    return null;
  }
}
export function validateClassificationFilter(filter: ClassificationFilter, rubric = loadJobRubric()): void {
  for (const dimension of ['domain', 'role', 'technology'] as const) {
    const label = filter[dimension];
    if (label !== undefined && !Object.hasOwn(rubric.dimensions[dimension], label)) {
      throw new Error(`Invalid --${dimension} "${label}". Choose: ${Object.keys(rubric.dimensions[dimension]).join(', ')}`);
    }
  }
}
export function matchesClassification(job: StoredJob, filter: ClassificationFilter, rubric = loadJobRubric()): boolean {
  const classification = readJobClassification(job, rubric);
  return (['domain', 'role', 'technology'] as const).every((dimension) => {
    const target = filter[dimension];
    if (target === undefined) return true;
    if (!classification) return !filter.strict;
    const value = classification.decision[dimension];
    const labels = 'labels' in value ? value.labels : [value.label];
    return labels.includes(target) || (!filter.strict && labels.includes('Unclear'));
  });
}
/** All statuses and ages are eligible; bounded source export makes no model decisions. */
export function buildClassificationBatch(
  db: Database.Database, rubric = loadJobRubric(), limit = 40, now = new Date(),
): ClassificationBatch {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Classification batch limit must be 1–100');
  const jobs: ClassificationBatch['jobs'] = [];
  for (const row of db.prepare('SELECT * FROM jobs ORDER BY id').iterate() as Iterable<StoredJob>) {
    if (!readJobClassification(row, rubric, now)) {
      jobs.push({ id: row.id, input_hash: projectInputHash(row), title: row.title, company: row.company, description: row.description_snippet });
      if (jobs.length === limit) break;
    }
  }
  return {
    workflow: 'job-classification', schemaVersion: 1, batchId: randomUUID(),
    databaseId: classificationDatabaseId(db), snapshotAt: now.toISOString(),
    rubricVersion: rubric.version, rubricHash: rubricHash(rubric), jobs,
  };
}
/** Validate complete authoritative batch and all current sources before the first write. */
export function saveClassificationBatch(
  db: Database.Database, input: unknown, manifest: ClassificationBatch, rubric = loadJobRubric(), now = new Date(),
): { updatedCount: number; preservedCount: number } {
  return db.transaction(() => {
    const value = object(input);
    const snapshotAt = iso(manifest.snapshotAt, now);
    if (manifest.workflow !== 'job-classification' || manifest.schemaVersion !== 1 ||
      manifest.databaseId !== classificationDatabaseId(db) || manifest.rubricVersion !== rubric.version ||
      manifest.rubricHash !== rubricHash(rubric) || !Array.isArray(manifest.jobs) || manifest.jobs.length > 100) {
      throw new Error('Classification manifest database or rubric mismatch');
    }
    for (const key of ['workflow', 'schemaVersion', 'batchId', 'databaseId', 'snapshotAt', 'rubricVersion', 'rubricHash'] as const) {
      if (value[key] !== manifest[key]) throw new Error('Classification input must match the exported batch manifest');
    }
    if (now.getTime() - Date.parse(snapshotAt) >= 7 * 86400000) throw new Error('Classification batch expired; export fresh sources');
    const model = text(value.model);
    if (!Array.isArray(value.decisions) || value.decisions.length !== manifest.jobs.length) {
      throw new Error('Classification decisions must cover the exact exported batch');
    }
    const selected = new Map(manifest.jobs.map((job) => [job.id, job]));
    if (selected.size !== manifest.jobs.length) throw new Error('Duplicate manifest job');
    const seen = new Set<number>();
    const read = db.prepare('SELECT * FROM jobs WHERE id = ?');
    const updates = value.decisions.map((raw) => {
      const id = object(raw).id;
      const source = typeof id === 'number' ? selected.get(id) : undefined;
      if (!source || seen.has(source.id)) throw new Error('Duplicate or out-of-batch classification job');
      seen.add(source.id);
      const job = read.get(source.id) as StoredJob | undefined;
      if (!job || source.input_hash !== projectInputHash(job) || source.title !== job.title ||
        source.company !== job.company || source.description !== job.description_snippet) {
        throw new Error('Changed classification source since export');
      }
      const decision = decisionFor(raw, job, rubric);
      const previous = readJobClassification(job, rubric, now);
      if (previous && (previous.model !== model || JSON.stringify(previous.decision) !== JSON.stringify(decision))) {
        throw new Error('Conflicting import cannot overwrite valid classification');
      }
      const saved: SavedJobClassification = {
        schemaVersion: 1, rubricVersion: rubric.version, rubricHash: manifest.rubricHash,
        input_hash: decision.input_hash, model, classifiedAt: now.toISOString(), decision,
      };
      return { job, previous, saved };
    });
    const write = db.prepare('UPDATE jobs SET classification_json = ? WHERE id = ?');
    let updatedCount = 0;
    for (const { job, previous, saved } of updates) {
      if (!previous) {
        write.run(JSON.stringify(saved), job.id);
        updatedCount++;
      }
    }
    return { updatedCount, preservedCount: updates.length - updatedCount };
  })();
}
