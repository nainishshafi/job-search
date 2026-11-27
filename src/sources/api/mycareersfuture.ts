import { detectAntiBotBlock, withBrowserPage } from '../playwright/browser.js';
import { isWithinDays } from '../../report/html.js';
import type {
  JobListing,
  JobSourcePlugin,
  SalaryInterval,
  SearchOptions,
  SourceFetchResult,
} from '../types.js';

const MCF_SEARCH_API = 'https://api.mycareersfuture.gov.sg/v2/search';

export interface McfRawJob {
  uuid?: string;
  title?: string;
  postedCompany?: { name?: string };
  salary?: {
    minimum?: number | null;
    maximum?: number | null;
    type?: { salaryType?: string };
  };
  employmentTypes?: Array<{ employmentType?: string }>;
  skills?: Array<{ skill?: string }>;
  metadata?: {
    jobPostId?: string;
    newPostingDate?: string;
    originalPostingDate?: string;
  };
  address?: {
    districts?: Array<{ region?: string; location?: string }>;
  };
  ssocCode?: number;
  description?: string;
}

interface McfApiResponse {
  results?: McfRawJob[];
  total?: number;
}

function mapSalaryInterval(rawType?: string): SalaryInterval | null {
  if (!rawType) return null;
  const lower = rawType.toLowerCase();
  if (lower.includes('month')) return 'monthly';
  if (lower.includes('year') || lower.includes('annual')) return 'annual';
  return null;
}

export function normalizeMcfJob(raw: McfRawJob): JobListing | null {
  const externalId = raw.uuid ?? raw.metadata?.jobPostId;
  const title = raw.title?.trim();
  if (!externalId || !title) {
    return null;
  }

  const company = raw.postedCompany?.name?.trim() || 'Unknown Company';
  const district = raw.address?.districts?.[0];
  const location =
    district?.location || district?.region || 'Singapore';

  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  const url = `https://www.mycareersfuture.gov.sg/job/information-technology/${slug}-${externalId}`;

  const skills = (raw.skills ?? [])
    .map((s) => s.skill?.trim())
    .filter((s): s is string => Boolean(s));

  const employmentType = raw.employmentTypes?.[0]?.employmentType ?? null;
  const snippet = raw.description
    ? raw.description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 280)
    : null;

  return {
    source: 'mycareersfuture',
    externalId,
    url,
    title,
    company,
    location,
    salaryMin: raw.salary?.minimum ?? null,
    salaryMax: raw.salary?.maximum ?? null,
    salaryCurrency: 'SGD',
    salaryInterval: mapSalaryInterval(raw.salary?.type?.salaryType),
    employmentType,
    descriptionSnippet: snippet,
    skills,
    postedAt:
      raw.metadata?.newPostingDate ?? raw.metadata?.originalPostingDate ?? null,
  };
}

async function fetchMcfViaPlaywright(
  options: SearchOptions,
): Promise<SourceFetchResult> {
  const jobs: JobListing[] = [];
  const knownIds = options.knownIds;

  return withBrowserPage(async (page) => {
    for (let pageNum = 0; jobs.length < options.limit; pageNum += 1) {
      const searchUrl = `https://www.mycareersfuture.gov.sg/search?search=${encodeURIComponent(options.query)}&sortBy=new_posting_date&page=${pageNum}`;
      const apiPromise = page
        .waitForResponse(
          (res) =>
            res.url().includes('/v2/search') &&
            res.request().method() === 'POST',
          { timeout: 15_000 },
        )
        .catch(() => null);

      await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });

      const blockReason = await detectAntiBotBlock(page);
      if (blockReason) {
        return { jobs, blockedReason: blockReason };
      }

      const apiRes = await apiPromise;
      if (!apiRes || !apiRes.ok()) {
        break;
      }

      const data = (await apiRes.json()) as McfApiResponse;
      const pageJobs = (data.results ?? [])
        .map(normalizeMcfJob)
        .filter((j): j is JobListing => j !== null);

      if (pageJobs.length === 0) {
        break;
      }

      let unseenOnPage = 0;
      let tooOldOnPage = 0;
      for (const job of pageJobs) {
        if (options.days !== undefined && !isWithinDays(job.postedAt, options.days)) {
          tooOldOnPage += 1;
          continue;
        }
        if (!knownIds?.has(job.externalId)) {
          unseenOnPage += 1;
        }
        jobs.push(job);
        if (jobs.length >= options.limit) break;
      }

      // Stop paginating once we reach a page of already-tracked jobs or jobs that are too old.
      if ((knownIds && knownIds.size > 0 && unseenOnPage === 0) || (options.days !== undefined && tooOldOnPage > 0)) {
        break;
      }
    }

    return { jobs };
  });
}

export async function fetchMyCareersFutureJobs(
  options: SearchOptions,
): Promise<SourceFetchResult> {
  const pageSize = Math.min(options.limit, 20);
  const jobs: JobListing[] = [];
  let page = 0;

  try {
    while (jobs.length < options.limit) {
      const response = await fetch(
        `${MCF_SEARCH_API}?limit=${pageSize}&page=${page}`,
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Origin: 'https://www.mycareersfuture.gov.sg',
            Referer: 'https://www.mycareersfuture.gov.sg/',
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          },
          body: JSON.stringify({
            sessionId: '',
            search: options.query,
            categories: ['Information Technology'],
            postingCompany: [],
            sortBy: ['new_posting_date'],
          }),
          signal: AbortSignal.timeout(8_000),
        },
      );

      if (response.status === 403 || response.status === 429) {
        return fetchMcfViaPlaywright(options);
      }

      if (!response.ok) {
        throw new Error(
          `MyCareersFuture API error: ${response.status} ${response.statusText}`,
        );
      }

      const data = (await response.json()) as McfApiResponse;
      const rawItems = data.results ?? [];
      if (rawItems.length === 0) {
        break;
      }

      let tooOldInBatch = 0;
      for (const raw of rawItems) {
        const normalized = normalizeMcfJob(raw);
        if (normalized) {
          if (options.days !== undefined && !isWithinDays(normalized.postedAt, options.days)) {
            tooOldInBatch += 1;
            continue;
          }
          jobs.push(normalized);
          if (jobs.length >= options.limit) break;
        }
      }

      if (rawItems.length < pageSize || (options.days !== undefined && tooOldInBatch > 0)) {
        break;
      }
      page += 1;
    }

    return { jobs };
  } catch {
    return fetchMcfViaPlaywright(options);
  }
}

export const myCareersFutureSource: JobSourcePlugin = {
  id: 'mycareersfuture',
  aliases: ['mcf'],
  label: 'MyCareersFuture SG',
  fetch: fetchMyCareersFutureJobs,
};
