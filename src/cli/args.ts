import path from 'node:path';
import { parseArgs } from 'node:util';
import { resolveSourceId } from '../sources/registry.js';
import type { JobSourceName, JobStatus } from '../sources/types.js';

export const DEFAULT_DB_PATH = path.resolve(process.cwd(), 'data', 'jobs.db');

export const VALID_STATUSES = new Set<JobStatus>([
  'new',
  'saved',
  'applied',
  'interviewing',
  'rejected',
  'archived',
]);

export interface CliValues {
  query?: string;
  sources?: string;
  limit?: string;
  status?: string;
  source?: string;
  search?: string;
  id?: string;
  notes?: string;
  db?: string;
  tokens?: string;
  url?: string;
  boards?: string;
  json?: boolean;
  days?: string;
  out?: string;
}

export function parseCliArgs(argv: string[]): {
  command?: string;
  values: CliValues;
} {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') {
    return { command, values: {} };
  }

  const { values } = parseArgs({
    args: rest,
    options: {
      query: { type: 'string', short: 'q' },
      sources: { type: 'string', short: 's' },
      limit: { type: 'string', short: 'l' },
      status: { type: 'string' },
      source: { type: 'string' },
      search: { type: 'string' },
      id: { type: 'string' },
      notes: { type: 'string' },
      db: { type: 'string', default: DEFAULT_DB_PATH },
      tokens: { type: 'string' },
      url: { type: 'string' },
      boards: { type: 'string' },
      json: { type: 'boolean', default: false },
      days: { type: 'string' },
      out: { type: 'string' },
    },
    allowPositionals: true,
  });

  return { command, values };
}

export function parseFilterArgs(
  statusRaw?: string,
  sourceRaw?: string,
):
  | { ok: true; status?: JobStatus; source?: JobSourceName }
  | { ok: false; error: string } {
  const status = statusRaw as JobStatus | undefined;
  if (status && !VALID_STATUSES.has(status)) {
    return { ok: false, error: `Error: invalid status "${status}"` };
  }
  let source: JobSourceName | undefined;
  if (sourceRaw) {
    source = resolveSourceId(sourceRaw);
    if (!source) {
      return { ok: false, error: `Error: invalid source "${sourceRaw}"` };
    }
  }
  return { ok: true, status, source };
}

export function parsePositiveIntArg(
  flagName: string,
  raw?: string,
  max?: number,
): { ok: true; value?: number } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: undefined };
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    return {
      ok: false,
      error: `Error: --${flagName} must be a positive integer (got "${raw}")`,
    };
  }
  return { ok: true, value: max !== undefined ? Math.min(n, max) : n };
}
