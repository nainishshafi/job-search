import type Database from 'better-sqlite3';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { getStats, listJobs, updateJobStatus } from '../db/client.js';
import { getPendingProjectJobs, projectInputHash, saveLlmProjectReview } from '../db/project-analysis.js';
import { getPendingCompanies, saveCompanyReview } from '../db/company-research.js';
import { buildClassifierSnapshot, validateClassifierReview, type ClassifierRubric, type ClassifierSnapshot } from '../classifier.js';
import { generateHtmlReport, isWithinDays } from '../report/html.js';
import { runSearch } from '../runner.js';
import { discoverBoards } from '../sources/api/discover.js';
import { readCompanyPage } from '../sources/playwright/company-pages.js';
import { resolveSourceIds } from '../sources/registry.js';
import type { JobSourceName, JobStatus } from '../sources/types.js';
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

function handleClassifier(db: Database.Database, values: CliValues): number {
  const rubric = JSON.parse(fs.readFileSync(path.resolve('config/job-classifier.json'), 'utf8')) as ClassifierRubric;
  const directory = path.resolve('data/classifier');
  const latestPath = path.join(directory, 'latest-review.json');
  const pendingPath = path.join(directory, 'pending-snapshot.json');
  const canonical = (file: string) => {
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
  };
  const sameFile = (first: string, second: string) => {
    if (canonical(first) === canonical(second)) return true;
    if (!fs.existsSync(first) || !fs.existsSync(second)) return false;
    const firstStat = fs.statSync(first);
    const secondStat = fs.statSync(second);
    return firstStat.ino !== 0 && firstStat.ino === secondStat.ino && firstStat.dev === secondStat.dev;
  };
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
        .filter(file => /^(review-\d.*\.json|report-.*\.md)$/.test(file))
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
  classifier: handleClassifier,
  research: handleResearch,
  analyze: handleAnalyze,
  full: handleFull,
  search: handleSearch,
  list: handleList,
  report: handleReport,
  update: handleUpdate,
  stats: handleStats,
};
