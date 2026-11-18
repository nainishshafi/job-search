import fs from 'node:fs';
import path from 'node:path';
import type { StoredJob } from '../db/client.js';

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

  const safeJson = JSON.stringify(jobs).replace(/</g, '\\u003c');

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
