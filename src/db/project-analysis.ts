import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { hasValidProjectAssessment, type StoredJob } from './client.js';
import { isWithinDays, parsePostedAtMs } from '../report/html.js';

export interface LlmDecision {
  id: number;
  input_hash: string;
  label: string;
  score: number | null;
  evidence: string;
  reasoning: string;
}

export interface LlmReview {
  model: string;
  snapshotAt: string;
  days: number;
  decisions: LlmDecision[];
}

export function projectInputHash(job: StoredJob): string {
  return createHash('sha256')
    .update(JSON.stringify([job.id, job.title, job.company, job.description_snippet]))
    .digest('hex');
}

/** Selection only: no classification or automatic scoring. */
export function getRecentProjectJobs(db: Database.Database, days: number, now = new Date()): StoredJob[] {
  if (!Number.isInteger(days) || days <= 0) throw new Error('days must be a positive integer');
  const cutoff = now.getTime() - days * 86400000;
  const jobs = db.prepare('SELECT * FROM jobs').all() as StoredJob[];
  return jobs.filter((job) => {
    if (job.posted_at && /^\d{4}-\d{2}-\d{2}$/.test(job.posted_at.trim())) {
      return isWithinDays(job.posted_at, days, now);
    }
    const lastSeen = Date.parse(`${job.last_seen_at.replace(' ', 'T')}Z`);
    return (parsePostedAtMs(job.posted_at, new Date(lastSeen)) ?? lastSeen) >= cutoff;
  });
}

export function getPendingProjectJobs(db: Database.Database, days: number, now = new Date()): StoredJob[] {
  return getRecentProjectJobs(db, days, now).filter((job) => !hasValidProjectAssessment(job));
}

/** Validate a complete LLM review before writing any of its decisions. */
export function saveLlmProjectReview(db: Database.Database, input: unknown): {
  jobs: StoredJob[]; counts: Record<string, number>; updatedCount: number;
} {
  if (!input || typeof input !== 'object') throw new Error('Expected an LLM review object');
  const review = input as LlmReview;
  if (typeof review.model !== 'string' || !review.model.trim() ||
      typeof review.snapshotAt !== 'string' || !Number.isFinite(Date.parse(review.snapshotAt)) ||
      !Number.isInteger(review.days) || review.days <= 0 || !Array.isArray(review.decisions)) {
    throw new Error('Review requires model, snapshotAt, positive days and decisions');
  }
  return db.transaction(() => {
    const jobs = getPendingProjectJobs(db, review.days, new Date(review.snapshotAt));
    const byId = new Map(jobs.map((job) => [job.id, job]));
    const seen = new Set<number>();
    for (const decision of review.decisions) {
      const job = decision && byId.get(decision.id);
      if (!job || seen.has(decision.id) || decision.input_hash !== projectInputHash(job)) {
        throw new Error('Review contains a duplicate, already analyzed, out-of-scope or changed job');
      }
      if (typeof decision.label !== 'string' || !decision.label.trim() ||
          typeof decision.reasoning !== 'string' || !decision.reasoning.trim() ||
          typeof decision.evidence !== 'string' ||
          !(decision.score === null || (Number.isInteger(decision.score) && decision.score >= 0 && decision.score <= 100)) ||
          (decision.label === 'Unclear') !== (decision.score === null)) {
        throw new Error(`Invalid LLM decision for job ${decision.id}`);
      }
      const sourceText = [job.title, job.company, job.description_snippet ?? ''];
      if (!decision.evidence.trim() || !sourceText.some((text) => text.includes(decision.evidence))) {
        throw new Error(`Evidence must quote the stored listing for job ${decision.id}`);
      }
      seen.add(decision.id);
    }
    if (seen.size !== jobs.length) throw new Error('Review must cover every pending recent job; no partial writes');
    const update = db.prepare(`
      UPDATE jobs SET project_type = @label, project_probability = @score,
        project_evidence = @evidence, project_reasoning = @reasoning,
        project_analysis_method = 'llm', project_analysis_model = @model,
        project_analyzed_at = @analyzedAt WHERE id = @id
    `);
    const counts: Record<string, number> = {};
    const analyzedAt = new Date().toISOString();
    for (const decision of review.decisions) {
      if (update.run({ ...decision, model: review.model, analyzedAt }).changes !== 1) {
        throw new Error('Failed to persist an LLM decision');
      }
      counts[decision.label] = (counts[decision.label] ?? 0) + 1;
    }
    // Read back the actual persisted rows for the report.
    return {
      jobs: getRecentProjectJobs(db, review.days, new Date(review.snapshotAt)),
      counts, updatedCount: review.decisions.length,
    };
  })();
}
