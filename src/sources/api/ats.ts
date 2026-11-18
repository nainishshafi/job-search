import fs from 'node:fs';
import path from 'node:path';
import type {
  JobListing,
  JobSourcePlugin,
  SearchOptions,
  SourceFetchResult,
} from '../types.js';

export interface AtsBoardConfig {
  token: string;
  company: string;
}

export interface AtsBoardsFile {
  greenhouse: AtsBoardConfig[];
  lever: AtsBoardConfig[];
}

const DEFAULT_BOARDS_PATH = path.resolve(process.cwd(), 'config', 'boards.json');

export function loadBoardConfig(
  configPath: string = DEFAULT_BOARDS_PATH,
): AtsBoardsFile {
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(raw) as Partial<AtsBoardsFile>;
  return {
    greenhouse: Array.isArray(parsed.greenhouse) ? parsed.greenhouse : [],
    lever: Array.isArray(parsed.lever) ? parsed.lever : [],
  };
}

export interface GreenhouseRawJob {
  id?: number | string;
  title?: string;
  absolute_url?: string;
  location?: { name?: string };
  updated_at?: string;
  content?: string;
}

export interface LeverRawJob {
  id?: string;
  text?: string;
  hostedUrl?: string;
  createdAt?: number;
  descriptionPlain?: string;
  categories?: {
    location?: string;
    commitment?: string;
  };
}

function isSingaporeLocation(location?: string): boolean {
  return Boolean(location && /\bsingapore\b/i.test(location));
}

function matchesQuery(text: string, query: string): boolean {
  const terms = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (terms.length === 0) return true;
  const hay = text.toLowerCase();
  return terms.every((term) => hay.includes(term));
}

export function normalizeGreenhouseJob(
  raw: GreenhouseRawJob,
  company: string,
): JobListing | null {
  const externalId = raw.id !== undefined ? String(raw.id) : '';
  const title = raw.title?.trim();
  const location = raw.location?.name?.trim() ?? '';
  if (
    !externalId ||
    !title ||
    !raw.absolute_url ||
    !isSingaporeLocation(location)
  ) {
    return null;
  }

  const snippet = raw.content
    ? raw.content
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 280)
    : null;

  return {
    source: 'greenhouse',
    externalId,
    url: raw.absolute_url,
    title,
    company,
    location,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: 'SGD',
    salaryInterval: null,
    employmentType: null,
    descriptionSnippet: snippet,
    skills: [],
    postedAt: raw.updated_at ?? null,
  };
}

export function normalizeLeverJob(
  raw: LeverRawJob,
  company: string,
): JobListing | null {
  const externalId = raw.id?.trim() ?? '';
  const title = raw.text?.trim();
  const location = raw.categories?.location?.trim() ?? '';
  if (
    !externalId ||
    !title ||
    !raw.hostedUrl ||
    !isSingaporeLocation(location)
  ) {
    return null;
  }

  const snippet = raw.descriptionPlain
    ? raw.descriptionPlain.replace(/\s+/g, ' ').trim().slice(0, 280)
    : null;

  return {
    source: 'lever',
    externalId,
    url: raw.hostedUrl,
    title,
    company,
    location,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: 'SGD',
    salaryInterval: null,
    employmentType: raw.categories?.commitment ?? null,
    descriptionSnippet: snippet,
    skills: [],
    postedAt: raw.createdAt ? new Date(raw.createdAt).toISOString() : null,
  };
}

async function fetchAtsBoards<TRaw>(
  boards: AtsBoardConfig[],
  buildUrl: (token: string) => string,
  extractItems: (payload: unknown) => TRaw[],
  normalize: (raw: TRaw, company: string) => JobListing | null,
  options: SearchOptions,
): Promise<SourceFetchResult> {
  if (boards.length === 0) {
    return { jobs: [] };
  }

  const results = await Promise.allSettled(
    boards.map(async (board) => {
      const res = await fetch(buildUrl(board.token), {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        throw new Error(`${board.company} (${board.token}): HTTP ${res.status}`);
      }
      const payload = (await res.json()) as unknown;
      const matched: JobListing[] = [];
      for (const raw of extractItems(payload)) {
        const job = normalize(raw, board.company);
        if (!job) continue;
        const searchable = `${job.title} ${job.descriptionSnippet ?? ''}`;
        if (matchesQuery(searchable, options.query)) {
          matched.push(job);
        }
      }
      return matched;
    }),
  );

  const jobs: JobListing[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') {
      jobs.push(...r.value);
    } else {
      console.warn(`[ats] Board fetch failed: ${String(r.reason)}`);
    }
  }
  return { jobs: jobs.slice(0, options.limit) };
}

export async function fetchGreenhouseJobs(
  options: SearchOptions,
  boards: AtsBoardConfig[] = loadBoardConfig().greenhouse,
): Promise<SourceFetchResult> {
  return fetchAtsBoards<GreenhouseRawJob>(
    boards,
    (token) =>
      `https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`,
    (payload) => ((payload as { jobs?: GreenhouseRawJob[] })?.jobs ?? []),
    normalizeGreenhouseJob,
    options,
  );
}

export async function fetchLeverJobs(
  options: SearchOptions,
  boards: AtsBoardConfig[] = loadBoardConfig().lever,
): Promise<SourceFetchResult> {
  return fetchAtsBoards<LeverRawJob>(
    boards,
    (token) => `https://api.lever.co/v0/postings/${token}?mode=json`,
    (payload) => (Array.isArray(payload) ? (payload as LeverRawJob[]) : []),
    normalizeLeverJob,
    options,
  );
}

export const greenhouseSource: JobSourcePlugin = {
  id: 'greenhouse',
  aliases: ['gh'],
  label: 'Greenhouse ATS Boards',
  fetch: (options) => fetchGreenhouseJobs(options),
};

export const leverSource: JobSourcePlugin = {
  id: 'lever',
  aliases: ['lv'],
  label: 'Lever ATS Boards',
  fetch: (options) => fetchLeverJobs(options),
};
