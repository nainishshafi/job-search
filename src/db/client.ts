import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { readCompanyResearch } from './company-research.js';
import { loadJobRubric, matchesClassification, validateClassificationFilter, type ClassificationFilter } from '../job-classification.js';
import type {
  JobListing,
  JobSourceName,
  JobStatus,
  ScrapeRunStatus,
} from '../sources/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

export interface StoredJob {
  id: number;
  source: JobSourceName;
  external_id: string;
  url: string;
  title: string;
  company: string;
  location: string;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string;
  salary_interval: string | null;
  employment_type: string | null;
  description_snippet: string | null;
  skills_json: string | null;
  posted_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  status: JobStatus;
  notes: string | null;
  project_type?: string | null;
  project_probability?: number | null;
  project_evidence?: string | null;
  project_analyzed_at?: string | null;
  project_analysis_method?: string | null;
  project_analysis_model?: string | null;
  project_reasoning?: string | null;
  company_research_json?: string | null;
  classification_json?: string | null;
}

export function hasValidProjectAssessment(job: StoredJob): boolean {
  const label = job.project_type;
  const score = job.project_probability;
  const evidence = job.project_evidence;
  return job.project_analysis_method === 'llm' &&
    typeof job.project_analyzed_at === 'string' && Number.isFinite(Date.parse(job.project_analyzed_at)) &&
    typeof job.project_analysis_model === 'string' && !!job.project_analysis_model.trim() &&
    typeof label === 'string' && !!label.trim() &&
    typeof job.project_reasoning === 'string' && !!job.project_reasoning.trim() &&
    typeof evidence === 'string' && !!evidence.trim() &&
    [job.title, job.company, job.description_snippet ?? ''].some((text) => text.includes(evidence)) &&
    (label === 'Unclear' ? score === null : typeof score === 'number' &&
      Number.isInteger(score) && score >= 0 && score <= 100);
}

export interface UpsertSummary {
  total: number;
  inserted: number;
  updated: number;
}

export interface ListJobsFilter extends ClassificationFilter {
  status?: JobStatus;
  source?: JobSourceName;
  search?: string;
  limit?: number;
  predicate?: (job: StoredJob) => boolean;
}

export function openDatabase(dbPath: string): Database.Database {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);
  if (dbPath !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }
  db.pragma('foreign_keys = ON');

  const schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schemaSql);
  const columns = new Set(
    (db.pragma('table_info(jobs)') as Array<{ name: string }>).map((column) => column.name),
  );
  db.transaction(() => {
    for (const [name, definition] of Object.entries({
      project_type: 'TEXT',
      project_probability: 'INTEGER CHECK (project_probability BETWEEN 0 AND 100)',
      project_evidence: 'TEXT',
      project_analyzed_at: 'TEXT',
      project_analysis_method: 'TEXT',
      project_analysis_model: 'TEXT',
      project_reasoning: 'TEXT',
      company_research_json: 'TEXT',
      classification_json: 'TEXT',
    })) {
      if (!columns.has(name)) db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${definition}`);
    }
  })();
  return db;
}

export function upsertJobs(
  db: Database.Database,
  jobs: JobListing[],
): UpsertSummary {
  if (jobs.length === 0) {
    return { total: 0, inserted: 0, updated: 0 };
  }

  const existsStmt = db.prepare<[string, string]>(
    'SELECT company, company_research_json FROM jobs WHERE source = ? AND external_id = ?',
  );

  const upsertStmt = db.prepare(`
    INSERT INTO jobs (
      source, external_id, url, title, company, location,
      salary_min, salary_max, salary_currency, salary_interval,
      employment_type, description_snippet, skills_json, posted_at, company_research_json
    ) VALUES (
      @source, @externalId, @url, @title, @company, @location,
      @salaryMin, @salaryMax, @salaryCurrency, @salaryInterval,
      @employmentType, @descriptionSnippet, @skillsJson, @postedAt, @companyResearch
    )
    ON CONFLICT(source, external_id) DO UPDATE SET
      url = excluded.url,
      title = excluded.title,
      company = excluded.company,
      location = excluded.location,
      salary_min = COALESCE(excluded.salary_min, jobs.salary_min),
      salary_max = COALESCE(excluded.salary_max, jobs.salary_max),
      salary_currency = excluded.salary_currency,
      salary_interval = COALESCE(excluded.salary_interval, jobs.salary_interval),
      employment_type = COALESCE(excluded.employment_type, jobs.employment_type),
      description_snippet = COALESCE(excluded.description_snippet, jobs.description_snippet),
      skills_json = COALESCE(excluded.skills_json, jobs.skills_json),
      posted_at = COALESCE(excluded.posted_at, jobs.posted_at),
      project_analyzed_at = CASE
        WHEN excluded.title IS NOT jobs.title
          OR excluded.company IS NOT jobs.company
          OR COALESCE(excluded.description_snippet, jobs.description_snippet) IS NOT jobs.description_snippet
        THEN NULL ELSE jobs.project_analyzed_at END,
      company_research_json = excluded.company_research_json,
      last_seen_at = datetime('now')
  `);

  let inserted = 0;
  let updated = 0;
  const researchStmt = db.prepare('SELECT company_research_json FROM jobs WHERE company = ? AND company_research_json IS NOT NULL');
  const researchCache = new Map<string, string | null>();

  const runBatch = db.transaction((items: JobListing[]) => {
    for (const job of items) {
      if (!researchCache.has(job.company)) {
        const rows = researchStmt.all(job.company) as Array<{ company_research_json: string }>;
        researchCache.set(job.company, rows.find((row) =>
          readCompanyResearch(row.company_research_json, job.company))?.company_research_json ?? null);
      }
      const existing = existsStmt.get(job.source, job.externalId) as
        { company: string; company_research_json: string | null } | undefined;
      const companyResearch = existing?.company === job.company &&
        readCompanyResearch(existing.company_research_json, job.company)
        ? existing.company_research_json : researchCache.get(job.company);
      upsertStmt.run({
        source: job.source,
        externalId: job.externalId,
        url: job.url,
        title: job.title,
        company: job.company,
        location: job.location,
        salaryMin: job.salaryMin,
        salaryMax: job.salaryMax,
        salaryCurrency: job.salaryCurrency,
        salaryInterval: job.salaryInterval,
        employmentType: job.employmentType,
        descriptionSnippet: job.descriptionSnippet,
        skillsJson: JSON.stringify(job.skills),
        postedAt: job.postedAt,
        companyResearch,
      });
      if (existing) {
        updated += 1;
      } else {
        inserted += 1;
      }
    }
  });

  runBatch(jobs);
  return { total: jobs.length, inserted, updated };
}

export function startRun(
  db: Database.Database,
  source: JobSourceName,
  query: string,
): number {
  const result = db
    .prepare(
      `INSERT INTO scrape_runs (source, query, status) VALUES (?, ?, 'running')`,
    )
    .run(source, query);
  return Number(result.lastInsertRowid);
}

export function finishRun(
  db: Database.Database,
  runId: number,
  status: Exclude<ScrapeRunStatus, 'running'>,
  jobsFound: number,
  jobsNew: number,
  errorMessage?: string,
): void {
  db.prepare(
    `UPDATE scrape_runs
     SET finished_at = datetime('now'),
         status = ?,
         jobs_found = ?,
         jobs_new = ?,
         error_message = ?
     WHERE id = ?`,
  ).run(status, jobsFound, jobsNew, errorMessage ?? null, runId);
}

export function listJobs(
  db: Database.Database,
  filter: ListJobsFilter = {},
): StoredJob[] {
  const clauses: string[] = [];
  const params: Record<string, string | number> = {};

  if (filter.status) {
    clauses.push('status = @status');
    params.status = filter.status;
  }
  if (filter.source) {
    clauses.push('source = @source');
    params.source = filter.source;
  }
  if (filter.search) {
    clauses.push(
      '(title LIKE @search OR company LIKE @search OR description_snippet LIKE @search)',
    );
    params.search = `%${filter.search}%`;
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
  params.limit = limit;

  const hasClassificationFilter = [filter.domain, filter.role, filter.technology].some(value => value !== undefined);
  if (hasClassificationFilter || filter.predicate) {
    const rubric = hasClassificationFilter ? loadJobRubric() : undefined;
    if (rubric) validateClassificationFilter(filter, rubric);
    delete params.limit;
    const matches: StoredJob[] = [];
    for (const job of db.prepare(`SELECT * FROM jobs ${where} ORDER BY last_seen_at DESC, id DESC`)
      .iterate(params) as Iterable<StoredJob>) {
      if ((!rubric || matchesClassification(job, filter, rubric)) && (!filter.predicate || filter.predicate(job))) {
        matches.push(job);
        if (matches.length === limit) break;
      }
    }
    return matches;
  }
  return db
    .prepare(
      `SELECT * FROM jobs ${where} ORDER BY last_seen_at DESC, id DESC LIMIT @limit`,
    )
    .all(params) as StoredJob[];
}

export function updateJobStatus(
  db: Database.Database,
  id: number,
  status: JobStatus,
  notes?: string,
): boolean {
  const result =
    notes !== undefined
      ? db
          .prepare('UPDATE jobs SET status = ?, notes = ? WHERE id = ?')
          .run(status, notes, id)
      : db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run(status, id);
  return result.changes > 0;
}

export function getKnownExternalIds(
  db: Database.Database,
  source: JobSourceName,
): Set<string> {
  const rows = db
    .prepare('SELECT external_id FROM jobs WHERE source = ?')
    .all(source) as Array<{ external_id: string }>;
  return new Set(rows.map((r) => r.external_id));
}

export function getStats(db: Database.Database): {
  byStatus: Array<{ status: string; count: number }>;
  bySource: Array<{
    source: string;
    total: number;
    new_count: number;
    latest_last_seen: string;
  }>;
  recentRuns: Array<{
    id: number;
    source: string;
    query: string;
    status: string;
    jobs_found: number;
    jobs_new: number;
    started_at: string;
  }>;
} {
  const byStatus = db
    .prepare('SELECT status, COUNT(*) as count FROM jobs GROUP BY status')
    .all() as Array<{ status: string; count: number }>;

  const bySource = db
    .prepare(
      `SELECT source,
              COUNT(*) as total,
              SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) as new_count,
              MAX(last_seen_at) as latest_last_seen
       FROM jobs
       GROUP BY source
       ORDER BY new_count DESC, total DESC`,
    )
    .all() as Array<{
    source: string;
    total: number;
    new_count: number;
    latest_last_seen: string;
  }>;

  const recentRuns = db
    .prepare(
      `SELECT id, source, query, status, jobs_found, jobs_new, started_at
       FROM scrape_runs ORDER BY id DESC LIMIT 10`,
    )
    .all() as Array<{
    id: number;
    source: string;
    query: string;
    status: string;
    jobs_found: number;
    jobs_new: number;
    started_at: string;
  }>;

  return { byStatus, bySource, recentRuns };
}
