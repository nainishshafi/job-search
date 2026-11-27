import fs from 'node:fs';
import path from 'node:path';
import { hasValidProjectAssessment, type StoredJob } from '../db/client.js';
import { readCompanyResearch } from '../db/company-research.js';
import { loadJobRubric, readJobClassification } from '../job-classification.js';

export interface HtmlReportOptions {
  title?: string;
  filterSummary?: string;
  outPath?: string;
  now?: Date;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function formatTimestampFilename(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = pad2(date.getMonth() + 1);
  const d = pad2(date.getDate());
  const hh = pad2(date.getHours());
  const mm = pad2(date.getMinutes());
  const ss = pad2(date.getSeconds());
  return `${y}-${m}-${d}_${hh}-${mm}-${ss}`;
}

export function isWithinDays(
  postedAt: string | null,
  days: number,
  now: Date = new Date(),
): boolean {
  if (!postedAt) return true;
  const trimmed = postedAt.trim().toLowerCase();
  if (trimmed.includes('m ago') || trimmed.includes('h ago')) return true;

  const dayMatch = trimmed.match(/^(\d+)d ago/);
  if (dayMatch) {
    return Number(dayMatch[1]) <= days;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(postedAt.trim())) {
    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const cutoffDay = `${cutoff.getUTCFullYear()}-${pad2(cutoff.getUTCMonth() + 1)}-${pad2(cutoff.getUTCDate())}`;
    return postedAt.trim() >= cutoffDay;
  }

  const parsed = Date.parse(postedAt);
  if (!Number.isNaN(parsed)) {
    const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
    return parsed >= cutoff;
  }

  return true;
}

function parseSqliteOrIsoMs(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // SQLite CURRENT_TIMESTAMP produces "YYYY-MM-DD HH:MM:SS" in UTC.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)
    ? `${trimmed.replace(' ', 'T')}Z`
    : trimmed;
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? null : parsed;
}

export function parsePostedAtMs(
  postedAt: string | null,
  anchor: Date = new Date(),
): number | null {
  if (!postedAt) return null;
  const trimmed = postedAt.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();

  if (lower === 'just now' || lower === 'today') {
    return anchor.getTime();
  }
  if (lower === 'yesterday') {
    return anchor.getTime() - 24 * 60 * 60 * 1000;
  }

  const relMatch = lower.match(/^(\d+)\s*\+?\s*([mhdw])\s+ago\b/);
  if (relMatch) {
    const amount = Number(relMatch[1]);
    const unitMs: Record<string, number> = {
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
      w: 7 * 24 * 60 * 60 * 1000,
    };
    return anchor.getTime() - amount * unitMs[relMatch[2]];
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const timePart = `${pad2(anchor.getUTCHours())}:${pad2(anchor.getUTCMinutes())}:${pad2(anchor.getUTCSeconds())}Z`;
    const combined = Date.parse(`${trimmed}T${timePart}`);
    if (!Number.isNaN(combined)) {
      return combined;
    }
  }

  return parseSqliteOrIsoMs(trimmed);
}

type JobDates = Pick<StoredJob, 'id' | 'posted_at' | 'first_seen_at' | 'last_seen_at'>;

export function getJobPostedAtMs(job: JobDates, now: Date = new Date()): number {
  const firstSeen = parseSqliteOrIsoMs(job.first_seen_at) ?? 0;
  const lastSeen = parseSqliteOrIsoMs(job.last_seen_at) ?? 0;
  const dateOnly = Boolean(job.posted_at && /^\d{4}-\d{2}-\d{2}$/.test(job.posted_at.trim()));
  const anchorMs = dateOnly ? firstSeen || lastSeen : lastSeen || firstSeen;
  return parsePostedAtMs(job.posted_at, anchorMs > 0 ? new Date(anchorMs) : now) ?? lastSeen;
}

function compareReportOrder(
  a: { id: number; postedAtMs: number; last_seen_at: string },
  b: { id: number; postedAtMs: number; last_seen_at: string },
): number {
  return b.postedAtMs - a.postedAtMs ||
    (parseSqliteOrIsoMs(b.last_seen_at) ?? 0) - (parseSqliteOrIsoMs(a.last_seen_at) ?? 0) ||
    b.id - a.id;
}

export function sortJobsByDateDesc<T extends JobDates>(
  jobs: T[],
  now: Date = new Date(),
): T[] {
  return jobs.map(job => ({ job, id: job.id, last_seen_at: job.last_seen_at, postedAtMs: getJobPostedAtMs(job, now) }))
    .sort(compareReportOrder).map(({ job }) => job);
}

export function assertHtmlReportDateOrder(html: string): void {
  if (!/<select id="sortOrder"[^>]*>\s*<option value="posted-desc" selected>[^<]*<\/option>(?:(?!<\/select>)[\s\S])*?<\/select>/.test(html) ||
      /<option value="id-desc"[^>]*\bselected\b/.test(html)) {
    throw new Error('HTML report does not default to newest posting first');
  }
  const payload = html.match(/<script id="jobs-data" type="application\/json">([^<]*)<\/script>/)?.[1];
  const rows = payload === undefined ? null : JSON.parse(payload);
  if (!Array.isArray(rows)) throw new Error('HTML report job data is missing or invalid');
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !Number.isSafeInteger(row.id) || !Number.isFinite(row.postedAtMs) ||
        typeof row.last_seen_at !== 'string') {
      throw new Error(`Invalid HTML report sort key at row ${i + 1}`);
    }
    if (i > 0 && compareReportOrder(rows[i - 1], row) > 0) {
      throw new Error(`HTML report is out of date order: job ${rows[i - 1].id} before job ${row.id}`);
    }
  }
}

function escapeHtmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function generateHtmlReport(
  jobs: StoredJob[],
  options: HtmlReportOptions = {},
): string {
  const now = options.now ?? new Date();
  const templatePath = path.join(import.meta.dirname, 'template.html');
  const template = fs.readFileSync(templatePath, 'utf-8');

  const title = options.title ?? 'Singapore IT Job Search Report';
  const filterSummary =
    options.filterSummary ?? `${jobs.length} job(s) matched`;
  const generatedAt = now.toLocaleString('en-SG', {
    dateStyle: 'medium',
    timeStyle: 'medium',
  });

  const rubric = loadJobRubric();
  const sortedJobs = sortJobsByDateDesc(jobs, now).map((job) => ({
    ...job,
    classification: readJobClassification(job, rubric, now),
    postedAtMs: getJobPostedAtMs(job, now),
    companyResearch: readCompanyResearch(job.company_research_json, job.company),
    projectEstimate: hasValidProjectAssessment(job)
      ? { label: job.project_type, score: job.project_probability ?? null, evidence: job.project_evidence,
          reasoning: job.project_reasoning, model: job.project_analysis_model }
      : { label: 'Not analyzed', score: null, evidence: 'Awaiting LLM review', reasoning: '', model: '' },
  }));
  const safeJson = JSON.stringify(sortedJobs).replace(/</g, '\\u003c');
  const classificationLabels = JSON.stringify(rubric.dimensions).replace(/</g, '\\u003c');

  const replacements: Record<string, string> = {
    TITLE: escapeHtmlText(title),
    FILTER_SUMMARY: escapeHtmlText(filterSummary),
    GENERATED_AT: escapeHtmlText(generatedAt),
    JOBS_JSON: safeJson,
    CLASSIFICATION_LABELS_JSON: classificationLabels,
  };
  const html = template.replace(
    /\{\{(TITLE|FILTER_SUMMARY|GENERATED_AT|JOBS_JSON|CLASSIFICATION_LABELS_JSON)\}\}/g,
    (_, key: string) => replacements[key],
  );
  assertHtmlReportDateOrder(html);

  const outPath = path.resolve(
    options.outPath ??
      path.join(
        process.cwd(),
        'data',
        'reports',
        `jobs-${formatTimestampFilename(now)}.html`,
      ),
  );
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html, 'utf-8');
  return outPath;
}
