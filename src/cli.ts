import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  getStats,
  listJobs,
  openDatabase,
  updateJobStatus,
} from './db/client.js';
import { runSearch } from './runner.js';
import { discoverBoards } from './sources/api/discover.js';
import {
  resolveSourceId,
  resolveSourceIds,
  SOURCE_REGISTRY,
} from './sources/registry.js';
import type { JobSourceName, JobStatus } from './sources/types.js';

const DEFAULT_DB_PATH = path.resolve(process.cwd(), 'data', 'jobs.db');

const VALID_STATUSES = new Set<JobStatus>([
  'new',
  'saved',
  'applied',
  'interviewing',
  'rejected',
  'archived',
]);

function formatSalary(
  min: number | null,
  max: number | null,
  currency: string,
  interval: string | null,
): string {
  if (min === null && max === null) return 'N/A';
  const range = min && max && min !== max ? `${min}-${max}` : `${min ?? max}`;
  return `${currency} ${range}${interval ? `/${interval}` : ''}`;
}

function printHelp(): void {
  const sources = SOURCE_REGISTRY.map(
    (s) => `${s.id} (${s.aliases.join(', ')})`,
  ).join(', ');
  console.log(`Singapore IT Job Search & SQLite Tracker

Registered sources: ${sources}

Commands:
  search    --query <text> [--sources <list>] [--limit 20] [--db path]
  list      [--status new|saved|applied|...] [--source <id>] [--search text] [--limit 25] [--db path]
  update    --id <jobId> --status <status> [--notes "text"] [--db path]
  stats     [--db path]
  discover  [--tokens gh:foo,lv:bar] [--url <page-url>] [--boards path]`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  const { values } = parseArgs({
    args: rest,
    options: {
      query: { type: 'string', short: 'q' },
      sources: { type: 'string', short: 's' },
      limit: { type: 'string', short: 'l', default: '20' },
      status: { type: 'string' },
      source: { type: 'string' },
      search: { type: 'string' },
      id: { type: 'string' },
      notes: { type: 'string' },
      db: { type: 'string', default: DEFAULT_DB_PATH },
      tokens: { type: 'string' },
      url: { type: 'string' },
      boards: { type: 'string' },
    },
    allowPositionals: true,
  });

  if (command === 'discover') {
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
    return;
  }

  const db = openDatabase(values.db ?? DEFAULT_DB_PATH);
  try {
    if (command === 'search') {
      const query = values.query?.trim();
      if (!query) {
        console.error('Error: --query is required for search');
        process.exitCode = 1;
        return;
      }
      const limit = Math.min(Math.max(Number(values.limit) || 20, 1), 100);
      let sources: string[];
      try {
        sources = resolveSourceIds(values.sources);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
        return;
      }
      const reports = await runSearch(db, { query, sources, limit });
      console.table(reports);
      return;
    }

    if (command === 'list') {
      const status = values.status as JobStatus | undefined;
      if (status && !VALID_STATUSES.has(status)) {
        console.error(`Error: invalid status "${status}"`);
        process.exitCode = 1;
        return;
      }
      let source: JobSourceName | undefined;
      if (values.source) {
        source = resolveSourceId(values.source);
        if (!source) {
          console.error(`Error: invalid source "${values.source}"`);
          process.exitCode = 1;
          return;
        }
      }
      const jobs = listJobs(db, {
        status,
        source,
        search: values.search,
        limit: Number(values.limit) || 25,
      });
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
      return;
    }

    if (command === 'update') {
      const id = Number(values.id);
      const status = values.status as JobStatus | undefined;
      if (!Number.isInteger(id) || id <= 0 || !status || !VALID_STATUSES.has(status)) {
        console.error('Error: valid --id and --status are required');
        process.exitCode = 1;
        return;
      }
      const updated = updateJobStatus(db, id, status, values.notes);
      if (!updated) {
        console.error(`No job found with id=${id}`);
        process.exitCode = 1;
        return;
      }
      console.log(`Updated job #${id} -> status="${status}"`);
      return;
    }

    if (command === 'stats') {
      const stats = getStats(db);
      console.log('Jobs by status:');
      console.table(stats.byStatus);
      console.log('Recent scrape runs:');
      console.table(stats.recentRuns);
      return;
    }

    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
