import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { getStats, listJobs, updateJobStatus } from '../db/client.js';
import { getPendingProjectJobs, projectInputHash, saveLlmProjectReview } from '../db/project-analysis.js';
import { getPendingCompanies, saveCompanyReview, readCompanyResearch } from '../db/company-research.js';
import { loadJobRubric, readJobClassification,
  validateClassificationFilter, type ClassificationFilter } from '../job-classification.js';
import { assertHtmlReportDateOrder, generateHtmlReport, isWithinDays } from '../report/html.js';
import { runSearch } from '../runner.js';
import { discoverBoards } from '../sources/api/discover.js';
import { readCompanyPage } from '../sources/playwright/company-pages.js';
import { resolveSourceIds } from '../sources/registry.js';
import type { JobSourceName, JobStatus } from '../sources/types.js';
import { handleClassify, handleClassifier } from './classifier-commands.js';
import {
  type CliValues,
  DEFAULT_FULL_QUERIES,
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
  opts: ClassificationFilter & {
    status?: JobStatus;
    source?: JobSourceName;
    search?: string;
    days?: number;
    limit: number;
    outPath?: string;
  },
): void {
  const jobs = listJobs(db, {
    status: opts.status,
    source: opts.source,
    search: opts.search,
    limit: opts.limit,
    domain: opts.domain, role: opts.role, technology: opts.technology, strict: opts.strict,
    predicate: opts.days === undefined ? undefined : job => isWithinDays(job.posted_at, opts.days!),
  });
  const { days } = opts;
  const parts: string[] = [`${jobs.length} job(s)`];
  if (opts.status) parts.push(`status=${opts.status}`);
  if (opts.source) parts.push(`source=${opts.source}`);
  if (days !== undefined) parts.push(`last ${days} day(s)`);
  if (opts.search) parts.push(`search="${opts.search}"`);
  for (const key of ['domain', 'role', 'technology'] as const) if (opts[key]) parts.push(`${key}=${opts[key]}`);
  if (opts.strict) parts.push('strict matches');
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

export async function handleFull(
  db: Database.Database,
  values: CliValues,
  fetchers?: Parameters<typeof runSearch>[1]['fetchers'],
): Promise<number> {
  const queryOverride = values.query?.trim();
  const queries = queryOverride ? [queryOverride] : DEFAULT_FULL_QUERIES;
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

  let failed = false;
  for (const query of queries) {
    console.log(`Searching for ${query}:`);
    const reports = await runSearch(db, {
      query,
      sources,
      limit: limitParsed.value ?? 30,
      days: daysParsed.value ?? 7,
      fetchers,
    });
    console.table(reports);
    if (reports.some((r) => r.status === 'failed')) failed = true;
  }
  printStats(db);
  buildAndWriteReport(db, {
    status: 'new',
    days: daysParsed.value ?? 7,
    limit: 500,
    outPath: values.out,
  });
  return failed ? 1 : 0;
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
  validateClassificationFilter(values);
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
    domain: values.domain, role: values.role, technology: values.technology, strict: values.strict,
  });
  const rubric = loadJobRubric();
  if (values.json) {
    console.log(JSON.stringify(jobs.map(job => ({ ...job, classification: readJobClassification(job, rubric) })), null, 2));
    return 0;
  }
  const rows = jobs.map((j) => {
    const classification = readJobClassification(j, rubric);
    return {
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
    domain: classification?.decision.domain.label ?? 'Pending',
    role: classification?.decision.role.label ?? 'Pending',
    technology: classification?.decision.technology.labels.join(', ') ?? 'Pending',
    };
  });
  console.table(rows);
  return 0;
}

function handleReport(db: Database.Database, values: CliValues): number {
  validateClassificationFilter(values);
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
    domain: values.domain, role: values.role, technology: values.technology, strict: values.strict,
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

function handleCheck(db: Database.Database, values: CliValues): number {
  const parsed = parsePositiveIntArg('days', values.days);
  if (!parsed.ok) {
    console.error(parsed.error);
    return 1;
  }
  const days = parsed.value ?? 7;
  const now = new Date();
  const jobs = listJobs(db, { limit: 1000, predicate: job => isWithinDays(job.posted_at, days, now) });
  if (values.input !== undefined) {
    try {
      assertHtmlReportDateOrder(fs.readFileSync(values.input, 'utf-8'));
      console.log('HTML report date order: verified (newest posting first).');
    } catch (error) {
      console.error(`HTML report date order check failed: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }

  const pendingClassification = jobs.filter(j => !readJobClassification(j, loadJobRubric(), now));
  const pendingResearch = jobs.filter(j => !readCompanyResearch(j.company_research_json, j.company));

  console.log(`Pipeline check for last ${days} days:`);
  console.log(`- Total jobs in scope: ${jobs.length}`);
  console.log(`- Pending classification: ${pendingClassification.length}`);
  console.log(`- Pending company research: ${pendingResearch.length}`);

  if (pendingClassification.length > 0 || pendingResearch.length > 0) {
    console.log('\nPipeline is INCOMPLETE. Run classification and research workflows.');
    return 1;
  }

  console.log('\nPipeline is COMPLETE.');
  return 0;
}

function handleAnalyze(db: Database.Database, values: CliValues): number {
  const parsed = parsePositiveIntArg('days', values.days);
  if (!parsed.ok) {
    console.error(parsed.error);
    return 1;
  }
  const days = parsed.value ?? 7;
  if (!values.input) {
    const snapshotAt = new Date().toISOString();
    const jobs = getPendingProjectJobs(db, days, new Date(snapshotAt));
    const outPath = path.resolve(values.out ?? 'data/reports/llm-review-input.json');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify({
      snapshotAt, days, jobs: jobs.map((job) => ({
        id: job.id, input_hash: projectInputHash(job), title: job.title,
        company: job.company, description: job.description_snippet,
      })),
    }, null, 2));
    console.log(`Exported ${jobs.length} pending jobs for LLM review: ${outPath}`);
    console.log('Database unchanged. Import completed LLM decisions with analyze --input <review.json>.');
    return 0;
  }
  const result = saveLlmProjectReview(db, JSON.parse(fs.readFileSync(values.input, 'utf8')));
  console.log(`Updated ${result.updatedCount} pending jobs with validated LLM decisions; preserved ${result.jobs.length - result.updatedCount} valid assessments.`);
  console.table(Object.entries(result.counts).map(([project_type, count]) => ({ project_type, count })));
  const outPath = generateHtmlReport(result.jobs, {
    filterSummary: `${result.jobs.length} job(s) • all statuses • persisted LLM estimates`,
    outPath: values.out,
  });
  console.log(`Report generated (${result.jobs.length} jobs): ${outPath}`);
  return 0;
}

async function handleResearch(db: Database.Database, values: CliValues): Promise<number> {
  if (values.url !== undefined) {
    if (values.input || values.company || values.days) {
      console.error('Error: research --url reads one browser page; do not combine with --input, --company or --days');
      return 1;
    }
    const evidence = await readCompanyPage(values.url);
    const json = JSON.stringify(evidence, null, 2);
    if (values.out) {
      const outPath = path.resolve(values.out);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, json);
      console.log(`Browser page ${evidence.status}: ${outPath}`);
    } else console.log(json);
    return evidence.status === 'retrieved' ? 0 : 1;
  }
  const parsed = parsePositiveIntArg('days', values.days);
  if (!parsed.ok) {
    console.error(parsed.error);
    return 1;
  }
  if (!values.input) {
    if (values.company !== undefined && !values.company.trim()) {
      console.error('Error: --company must be a nonempty exact employer name');
      return 1;
    }
    const snapshotAt = new Date().toISOString();
    const days = parsed.value ?? 7;
    const companies = getPendingCompanies(db, days, new Date(snapshotAt), values.company);
    const outPath = path.resolve(values.out ?? 'data/reports/company-research-input.json');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify({ snapshotAt, days, company: values.company, companies }, null, 2));
    console.log(`Exported ${companies.length} pending companies for LLM web research: ${outPath}`);
    console.log('Database unchanged. The LLM must web search company, Glassdoor, and founders for small or unknown-size employers.');
    return 0;
  }
  const result = saveCompanyReview(db, JSON.parse(fs.readFileSync(values.input, 'utf8')));
  console.log(`Researched ${result.updatedCompanies} companies; updated company research on ${result.updatedJobs} jobs. Project assessments, statuses and notes preserved.`);
  const outPath = generateHtmlReport(result.jobs, {
    filterSummary: `${result.jobs.length} job(s) • all statuses • persisted project assessments and company research`,
    outPath: values.out,
  });
  console.log(`Report generated (${result.jobs.length} jobs): ${outPath}`);
  return 0;
}

export const DB_COMMANDS: Record<string, DbCommandHandler> = {
  classify: handleClassify,
  classifier: handleClassifier,
  research: handleResearch,
  analyze: handleAnalyze,
  full: handleFull,
  search: handleSearch,
  list: handleList,
  report: handleReport,
  update: handleUpdate,
  stats: handleStats,
  check: handleCheck,
};
