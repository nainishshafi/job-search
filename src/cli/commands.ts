import type Database from 'better-sqlite3';
import { getStats, listJobs, updateJobStatus } from '../db/client.js';
import { generateHtmlReport, isWithinDays } from '../report/html.js';
import { runSearch } from '../runner.js';
import { discoverBoards } from '../sources/api/discover.js';
import { resolveSourceIds } from '../sources/registry.js';
import type { JobSourceName, JobStatus } from '../sources/types.js';
import {
  type CliValues,
  VALID_STATUSES,
  parseFilterArgs,
  parsePositiveIntArg,
} from './args.js';

export type DbCommandHandler = (
  db: Database.Database,
  values: CliValues,
) => Promise<number> | number;

export function formatSalary(
  min: number | null,
  max: number | null,
  currency: string,
  interval: string | null,
): string {
  if (min === null && max === null) return 'N/A';
  const range = min && max && min !== max ? `${min}-${max}` : `${min ?? max}`;
  return `${currency} ${range}${interval ? `/${interval}` : ''}`;
}

function printStats(db: Database.Database): void {
  const stats = getStats(db);
  console.log('Jobs by status:');
  console.table(stats.byStatus);
  console.log('Jobs by source:');
  console.table(stats.bySource);
  console.log('Recent scrape runs:');
  console.table(stats.recentRuns);
}

function buildAndWriteReport(
  db: Database.Database,
  opts: {
    status?: JobStatus;
    source?: JobSourceName;
    search?: string;
    days?: number;
    limit: number;
    outPath?: string;
  },
): void {
  let jobs = listJobs(db, {
    status: opts.status,
    source: opts.source,
    search: opts.search,
    limit: opts.limit,
  });
  const { days } = opts;
  if (days !== undefined) {
    jobs = jobs.filter((j) => isWithinDays(j.posted_at, days));
  }
  const parts: string[] = [`${jobs.length} job(s)`];
  if (opts.status) parts.push(`status=${opts.status}`);
  if (opts.source) parts.push(`source=${opts.source}`);
  if (days !== undefined) parts.push(`last ${days} day(s)`);
  if (opts.search) parts.push(`search="${opts.search}"`);
  const outPath = generateHtmlReport(jobs, {
    filterSummary: parts.join(' • '),
    outPath: opts.outPath,
  });
  console.log(`Report generated (${jobs.length} jobs): ${outPath}`);
}

export async function handleDiscover(values: CliValues): Promise<number> {
  const result = await discoverBoards({
    tokens: values.tokens,
    url: values.url,
    boardsPath: values.boards,
  });
  console.log(
    `Probed ${result.probed} candidate board(s), added ${result.added.length} Singapore-active board(s).`,
  );
  if (result.added.length > 0) {
    console.table(result.added);
  }
  return 0;
}

async function handleFull(
  db: Database.Database,
  values: CliValues,
): Promise<number> {
  const query = values.query?.trim() || 'Java';
  const limitParsed = parsePositiveIntArg('limit', values.limit, 100);
  if (!limitParsed.ok) {
    console.error(limitParsed.error);
    return 1;
  }
  const daysParsed = parsePositiveIntArg('days', values.days);
  if (!daysParsed.ok) {
    console.error(daysParsed.error);
    return 1;
  }
  let sources: string[];
  try {
    sources = resolveSourceIds(values.sources);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const reports = await runSearch(db, {
    query,
    sources,
    limit: limitParsed.value ?? 50,
  });
  console.table(reports);
  printStats(db);
  buildAndWriteReport(db, {
    status: 'new',
    days: daysParsed.value ?? 7,
    limit: 500,
    outPath: values.out,
  });
  return reports.some((r) => r.status === 'failed') ? 1 : 0;
}

async function handleSearch(
  db: Database.Database,
  values: CliValues,
): Promise<number> {
  const query = values.query?.trim();
  if (!query) {
    console.error('Error: --query is required for search');
    return 1;
  }
  const limitParsed = parsePositiveIntArg('limit', values.limit, 100);
  if (!limitParsed.ok) {
    console.error(limitParsed.error);
    return 1;
  }
  let sources: string[];
  try {
    sources = resolveSourceIds(values.sources);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const reports = await runSearch(db, {
    query,
    sources,
    limit: limitParsed.value ?? 20,
  });
  console.table(reports);
  return 0;
}

function handleList(db: Database.Database, values: CliValues): number {
  const filters = parseFilterArgs(values.status, values.source);
  if (!filters.ok) {
    console.error(filters.error);
    return 1;
  }
  const limitParsed = parsePositiveIntArg('limit', values.limit, 500);
  if (!limitParsed.ok) {
    console.error(limitParsed.error);
    return 1;
  }

  const jobs = listJobs(db, {
    status: filters.status,
    source: filters.source,
    search: values.search,
    limit: limitParsed.value ?? 25,
  });
  if (values.json) {
    console.log(JSON.stringify(jobs, null, 2));
    return 0;
  }
  const rows = jobs.map((j) => ({
    id: j.id,
    source: j.source,
    title: j.title.slice(0, 42),
    company: j.company.slice(0, 24),
    salary: formatSalary(
      j.salary_min,
      j.salary_max,
      j.salary_currency,
      j.salary_interval,
    ),
    posted: j.posted_at ?? 'N/A',
    status: j.status,
    last_seen: j.last_seen_at,
  }));
  console.table(rows);
  return 0;
}

function handleReport(db: Database.Database, values: CliValues): number {
  const filters = parseFilterArgs(values.status, values.source);
  if (!filters.ok) {
    console.error(filters.error);
    return 1;
  }
  const daysParsed = parsePositiveIntArg('days', values.days);
  if (!daysParsed.ok) {
    console.error(daysParsed.error);
    return 1;
  }
  const limitParsed = parsePositiveIntArg('limit', values.limit, 500);
  if (!limitParsed.ok) {
    console.error(limitParsed.error);
    return 1;
  }

  buildAndWriteReport(db, {
    status: filters.status,
    source: filters.source,
    search: values.search,
    days: daysParsed.value,
    limit: limitParsed.value ?? 500,
    outPath: values.out,
  });
  return 0;
}

function handleUpdate(db: Database.Database, values: CliValues): number {
  const id = Number(values.id);
  const status = values.status as JobStatus | undefined;
  if (
    !Number.isInteger(id) ||
    id <= 0 ||
    !status ||
    !VALID_STATUSES.has(status)
  ) {
    console.error('Error: valid --id and --status are required');
    return 1;
  }
  const updated = updateJobStatus(db, id, status, values.notes);
  if (!updated) {
    console.error(`No job found with id=${id}`);
    return 1;
  }
  console.log(`Updated job #${id} -> status="${status}"`);
  return 0;
}

function handleStats(db: Database.Database): number {
  printStats(db);
  return 0;
}

export const DB_COMMANDS: Record<string, DbCommandHandler> = {
  full: handleFull,
  search: handleSearch,
  list: handleList,
  report: handleReport,
  update: handleUpdate,
  stats: handleStats,
};
