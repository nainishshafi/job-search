import type Database from 'better-sqlite3';
import {
  finishRun,
  getKnownExternalIds,
  startRun,
  upsertJobs,
} from './db/client.js';
import { getSourceFetcher } from './sources/registry.js';
import type { JobFetcher, JobSourceName } from './sources/types.js';

export interface SourceRunReport {
  source: JobSourceName;
  status: 'success' | 'failed' | 'blocked';
  jobsFound: number;
  jobsNew: number;
  jobsUpdated: number;
  error?: string;
}

export async function runSearch(
  db: Database.Database,
  options: {
    query: string;
    sources: JobSourceName[];
    limit: number;
    days?: number;
    fetchers?: Partial<Record<JobSourceName, JobFetcher>>;
  },
): Promise<SourceRunReport[]> {
  const reports: SourceRunReport[] = [];

  for (const source of options.sources) {
    const fetcher = options.fetchers?.[source] ?? getSourceFetcher(source);
    if (!fetcher) {
      reports.push({
        source,
        status: 'failed',
        jobsFound: 0,
        jobsNew: 0,
        jobsUpdated: 0,
        error: `Unknown job source: ${source}`,
      });
      continue;
    }

    const knownIds = getKnownExternalIds(db, source);
    const runId = startRun(db, source, options.query);

    try {
      const result = await fetcher({
        query: options.query,
        limit: options.limit,
        days: options.days,
        knownIds,
      });

      const summary = upsertJobs(db, result.jobs);

      if (result.blockedReason) {
        finishRun(
          db,
          runId,
          'blocked',
          summary.total,
          summary.inserted,
          result.blockedReason,
        );
        reports.push({
          source,
          status: 'blocked',
          jobsFound: summary.total,
          jobsNew: summary.inserted,
          jobsUpdated: summary.updated,
          error: result.blockedReason,
        });
        continue;
      }

      finishRun(db, runId, 'success', summary.total, summary.inserted);
      reports.push({
        source,
        status: 'success',
        jobsFound: summary.total,
        jobsNew: summary.inserted,
        jobsUpdated: summary.updated,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      finishRun(db, runId, 'failed', 0, 0, message);
      reports.push({
        source,
        status: 'failed',
        jobsFound: 0,
        jobsNew: 0,
        jobsUpdated: 0,
        error: message,
      });
    }
  }

  return reports;
}
