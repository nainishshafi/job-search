import fs from 'node:fs';
import path from 'node:path';
import { hasValidProjectAssessment, type StoredJob } from '../db/client.js';

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

export function sortJobsByDateDesc(
  jobs: StoredJob[],
  now: Date = new Date(),
): StoredJob[] {
  return [...jobs].sort((a, b) => {
    const aFirstSeen = parseSqliteOrIsoMs(a.first_seen_at) ?? 0;
    const bFirstSeen = parseSqliteOrIsoMs(b.first_seen_at) ?? 0;
    const aLastSeen = parseSqliteOrIsoMs(a.last_seen_at) ?? 0;
    const bLastSeen = parseSqliteOrIsoMs(b.last_seen_at) ?? 0;

    const aIsDateOnly = Boolean(
      a.posted_at && /^\d{4}-\d{2}-\d{2}$/.test(a.posted_at.trim()),
    );
    const bIsDateOnly = Boolean(
      b.posted_at && /^\d{4}-\d{2}-\d{2}$/.test(b.posted_at.trim()),
    );

    const aAnchorMs = aIsDateOnly
      ? aFirstSeen || aLastSeen
      : aLastSeen || aFirstSeen;
    const bAnchorMs = bIsDateOnly
      ? bFirstSeen || bLastSeen
      : bLastSeen || bFirstSeen;

    const aAnchor = aAnchorMs > 0 ? new Date(aAnchorMs) : now;
    const bAnchor = bAnchorMs > 0 ? new Date(bAnchorMs) : now;

    const aPosted = parsePostedAtMs(a.posted_at, aAnchor) ?? aLastSeen;
    const bPosted = parsePostedAtMs(b.posted_at, bAnchor) ?? bLastSeen;

    if (bPosted !== aPosted) {
      return bPosted - aPosted;
    }
    if (bLastSeen !== aLastSeen) {
      return bLastSeen - aLastSeen;
    }
    return b.id - a.id;
  });
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

  const sortedJobs = sortJobsByDateDesc(jobs, now).map((job) => ({
    ...job,
    projectEstimate: hasValidProjectAssessment(job)
      ? { label: job.project_type, score: job.project_probability ?? null, evidence: job.project_evidence,
          reasoning: job.project_reasoning, model: job.project_analysis_model }
      : { label: 'Not analyzed', score: null, evidence: 'Awaiting LLM review', reasoning: '', model: '' },
  }));
  const safeJson = JSON.stringify(sortedJobs).replace(/</g, '\\u003c');

  const html = template
    .replaceAll('{{TITLE}}', () => escapeHtmlText(title))
    .replaceAll('{{FILTER_SUMMARY}}', () => escapeHtmlText(filterSummary))
    .replaceAll('{{GENERATED_AT}}', () => escapeHtmlText(generatedAt))
    .replace('{{JOBS_JSON}}', () => safeJson);

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
