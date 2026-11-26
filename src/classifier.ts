import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { StoredJob } from './db/client.js';
import { projectInputHash } from './db/project-analysis.js';

export interface ClassifierRubric {
  version: number;
  dimensions: {
    domain: Record<string, string>;
    role: Record<string, string>;
    technology: Record<string, string>;
  };
}

export interface ClassifierJob {
  id: number;
  input_hash: string;
  title: string;
  company: string;
  description: string | null;
  previousDomain: string | null;
  previousReasoning: string | null;
}

export interface ClassifierSnapshot {
  snapshotAt: string;
  sampleLimit: number;
  sampleSeed: string;
  rubricVersion: number;
  rubricHash: string;
  corpusCount: number;
  existingDomainCounts: Record<string, number>;
  reviewDue: boolean;
  jobs: ClassifierJob[];
}

export interface ClassifierDimension {
  label: string;
  score: number | null;
  evidence: string;
  reasoning: string;
}

export interface ClassifierDecision {
  id: number;
  input_hash: string;
  domain: ClassifierDimension;
  role: ClassifierDimension;
  technology: Omit<ClassifierDimension, 'label'> & { labels: string[] };
}

export interface ClassifierReview {
  snapshotAt: string;
  sampleLimit: number;
  sampleSeed: string;
  rubricVersion: number;
  rubricHash: string;
  model: string;
  corpusCount: number;
  decisions: ClassifierDecision[];
  reviewedAt: string;
}

const DAY = 86400000;
const dimensions = ['domain', 'role', 'technology'] as const;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Expected a nonempty string');
  return value;
}
function timestamp(value: unknown, now: Date): string {
  const iso = text(value);
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== iso || date > now) {
    throw new Error('Expected a valid nonfuture ISO timestamp');
  }
  return iso;
}
function sampleLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error('sampleLimit must be a positive integer');
  }
  return value;
}
function rubricHash(rubric: ClassifierRubric): string {
  const value = object(rubric);
  if (!Number.isSafeInteger(value.version) || (value.version as number) <= 0) throw new Error('Invalid rubric version');
  const definitions = object(value.dimensions);
  const entries = dimensions.map((dimension) => {
    const labels = object(definitions[dimension]);
    if (!Object.hasOwn(labels, 'Unclear')) throw new Error(`Rubric ${dimension} requires Unclear`);
    return [dimension, Object.keys(labels).sort().map((label) => [text(label), text(labels[label])])];
  });
  return createHash('sha256').update(JSON.stringify([value.version, entries])).digest('hex');
}
function readJobs(db: Database.Database): StoredJob[] {
  return db.prepare('SELECT * FROM jobs ORDER BY id').all() as StoredJob[];
}
function selectJobs(jobs: StoredJob[], limit: number, snapshotAt: string): StoredJob[] {
  const date = new Date(snapshotAt);
  const seed = Math.floor((date.getTime() - Date.UTC(date.getUTCFullYear(), 0, 1)) / DAY);
  const groups = new Map<string, StoredJob[]>();
  for (const job of jobs) {
    const label = job.project_type ?? 'Unclear';
    const group = groups.get(label) ?? [];
    group.push(job);
    groups.set(label, group);
  }
  const unclear = groups.get('Unclear') ?? [];
  let active = [...groups.keys()].filter((label) => label !== 'Unclear').sort().map((label) => groups.get(label)!);
  const target = Math.min(limit, jobs.length);
  const selected: StoredJob[] = [];
  // Existing labels diversify examples; they are not classification ground truth.
  const quota = Math.min(unclear.length, Math.ceil(target * 0.2));
  for (let i = 0; i < quota; i++) selected.push(unclear[(seed + i) % unclear.length]);
  for (let round = 0; selected.length < target && active.length; round++) {
    const slots = Math.min(target - selected.length, active.length);
    // Spread a truncated round over the whole label range, not its alphabetic prefix.
    for (let i = 0; i < slots; i++) {
      const group = active[(seed + Math.floor(i * active.length / slots)) % active.length];
      selected.push(group[(seed + round) % group.length]);
    }
    active = active.filter((group) => round + 1 < group.length);
  }
  for (let i = quota; selected.length < target; i++) selected.push(unclear[(seed + i) % unclear.length]);
  return selected;
}
function validateDimension(input: unknown, labels: Record<string, string>, job: StoredJob, multi: boolean) {
  const value = object(input);
  const chosen = multi ? value.labels : [value.label];
  if (!Array.isArray(chosen) || !chosen.length || [...chosen].some((label) =>
    typeof label !== 'string' || !Object.hasOwn(labels, label)) || new Set(chosen).size !== chosen.length) {
    throw new Error(`Unknown or duplicate labels for job ${job.id}`);
  }
  const unclear = chosen.includes('Unclear');
  if ((unclear && chosen.length !== 1) || (unclear ? value.score !== null :
    typeof value.score !== 'number' || !Number.isInteger(value.score) || value.score < 0 || value.score > 100)) {
    throw new Error(`Invalid score or mixed Unclear labels for job ${job.id}`);
  }
  const evidence = text(value.evidence);
  if (![job.title, job.company, job.description_snippet ?? ''].some((source) => source.includes(evidence))) {
    throw new Error(`Evidence must quote a contiguous stored source for job ${job.id}`);
  }
  return { labels: chosen as string[], score: value.score as number | null, evidence, reasoning: text(value.reasoning) };
}
function validateReview(jobs: StoredJob[], rubric: ClassifierRubric, hash: string, input: unknown, now: Date): ClassifierReview {
  const value = object(input);
  const snapshotAt = timestamp(value.snapshotAt, now);
  const limit = sampleLimit(value.sampleLimit === undefined ? 40 : value.sampleLimit);
  if ((value.sampleSeed !== undefined && value.sampleSeed !== snapshotAt) ||
    value.rubricVersion !== rubric.version || value.rubricHash !== hash || value.corpusCount !== jobs.length) {
    throw new Error('Review snapshot seed, rubric or corpus mismatch');
  }
  const model = text(value.model);
  if (!Array.isArray(value.decisions)) throw new Error('Review decisions must be an array');
  const selected = selectJobs(jobs, limit, snapshotAt);
  if (value.decisions.length !== selected.length) throw new Error('Review must cover the exact sample');
  const byId = new Map(selected.map((job) => [job.id, job]));
  const seen = new Set<number>();
  const decisions = value.decisions.map((inputDecision): ClassifierDecision => {
    const decision = object(inputDecision);
    const job = typeof decision.id === 'number' ? byId.get(decision.id) : undefined;
    if (!job || seen.has(job.id) || decision.input_hash !== projectInputHash(job)) {
      throw new Error('Duplicate, out-of-sample or changed source hash');
    }
    seen.add(job.id);
    const domain = validateDimension(decision.domain, rubric.dimensions.domain, job, false);
    const role = validateDimension(decision.role, rubric.dimensions.role, job, false);
    const technology = validateDimension(decision.technology, rubric.dimensions.technology, job, true);
    return {
      id: job.id, input_hash: projectInputHash(job),
      domain: { label: domain.labels[0], score: domain.score, evidence: domain.evidence, reasoning: domain.reasoning },
      role: { label: role.labels[0], score: role.score, evidence: role.evidence, reasoning: role.reasoning },
      technology: { ...technology, labels: [...technology.labels] },
    };
  });
  if (seen.size !== selected.length) throw new Error('Review must cover the exact sample');
  return {
    snapshotAt, sampleLimit: limit, sampleSeed: snapshotAt, rubricVersion: rubric.version, rubricHash: hash,
    model, corpusCount: jobs.length, decisions, reviewedAt: now.toISOString(),
  };
}

/** Export source examples only; all classification decisions belong to the harness. */
export function buildClassifierSnapshot(
  db: Database.Database, rubric: ClassifierRubric, limit = 40, now = new Date(), previousReview?: unknown,
): ClassifierSnapshot {
  const snapshotAt = now.toISOString();
  sampleLimit(limit);
  const hash = rubricHash(rubric);
  const jobs = readJobs(db);
  const existingDomainCounts: Record<string, number> = Object.create(null);
  for (const job of jobs) {
    const label = job.project_type ?? 'Unclear';
    existingDomainCounts[label] = (existingDomainCounts[label] ?? 0) + 1;
  }
  let reviewDue = true;
  try {
    validateReview(jobs, rubric, hash, previousReview, now);
    const reviewedAt = timestamp(object(previousReview).reviewedAt, now);
    if (reviewedAt < text(object(previousReview).snapshotAt)) throw new Error('Review predates snapshot');
    // Reimporting historical decisions cannot restart the review cycle.
    reviewDue = now.getTime() - Date.parse(text(object(previousReview).snapshotAt)) >= 7 * DAY;
  } catch {
    // Invalid, stale-source or missing previous reviews always need a fresh harness review.
  }
  return {
    snapshotAt, sampleLimit: limit, sampleSeed: snapshotAt, rubricVersion: rubric.version, rubricHash: hash,
    corpusCount: jobs.length, existingDomainCounts, reviewDue,
    jobs: selectJobs(jobs, limit, snapshotAt).map((job) => ({
      id: job.id, input_hash: projectInputHash(job), title: job.title, company: job.company,
      description: job.description_snippet, previousDomain: job.project_type ?? null,
      previousReasoning: job.project_reasoning ?? null,
    })),
  };
}

/** Validate without writes; persistence and actual model invocation belong to the parent. */
export function validateClassifierReview(
  db: Database.Database, rubric: ClassifierRubric, input: unknown, expectedSnapshot?: ClassifierSnapshot,
): ClassifierReview {
  const review = validateReview(readJobs(db), rubric, rubricHash(rubric), input, new Date());
  if (expectedSnapshot) {
    for (const key of ['snapshotAt', 'sampleLimit', 'sampleSeed', 'rubricVersion', 'rubricHash', 'corpusCount'] as const) {
      if (review[key] !== expectedSnapshot[key]) throw new Error('Review must match the exported snapshot metadata');
    }
    const expected = new Map(expectedSnapshot.jobs.map(job => [job.id, job.input_hash]));
    if (review.decisions.length !== expectedSnapshot.jobs.length ||
      review.decisions.some(decision => expected.get(decision.id) !== decision.input_hash)) {
      throw new Error('Review must cover the exported snapshot sample');
    }
  }
  return review;
}
