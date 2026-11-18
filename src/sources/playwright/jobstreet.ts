import type {
  JobListing,
  JobSourcePlugin,
  SalaryInterval,
  SearchOptions,
  SourceFetchResult,
} from '../types.js';
import { detectAntiBotBlock, withBrowserPage } from './browser.js';

export interface RawJobStreetCard {
  externalId: string;
  url: string;
  title: string;
  company: string;
  location: string;
  salaryText: string | null;
  snippet: string | null;
  postedText: string | null;
}

export function parseSgdSalary(salaryText: string | null): {
  salaryMin: number | null;
  salaryMax: number | null;
  salaryInterval: SalaryInterval | null;
} {
  if (!salaryText) {
    return { salaryMin: null, salaryMax: null, salaryInterval: null };
  }

  const matches = [...salaryText.matchAll(/(\d[\d,]*)/g)].map((m) =>
    Number(m[1].replace(/,/g, '')),
  );
  const valid = matches.filter((n) => Number.isFinite(n) && n > 0);
  if (valid.length === 0) {
    return { salaryMin: null, salaryMax: null, salaryInterval: null };
  }

  const lower = salaryText.toLowerCase();
  const salaryInterval: SalaryInterval | null = lower.includes('year') || lower.includes('annum')
    ? 'annual'
    : lower.includes('month')
      ? 'monthly'
      : null;

  return {
    salaryMin: valid[0],
    salaryMax: valid[1] ?? valid[0],
    salaryInterval,
  };
}

export function normalizeJobStreetCard(card: RawJobStreetCard): JobListing | null {
  const title = card.title.trim();
  const externalId = card.externalId.trim();
  if (!title || !externalId) {
    return null;
  }

  const { salaryMin, salaryMax, salaryInterval } = parseSgdSalary(card.salaryText);

  return {
    source: 'jobstreet',
    externalId,
    url: card.url,
    title,
    company: card.company.trim() || 'Unknown Company',
    location: card.location.trim() || 'Singapore',
    salaryMin,
    salaryMax,
    salaryCurrency: 'SGD',
    salaryInterval,
    employmentType: null,
    descriptionSnippet: card.snippet?.trim().slice(0, 280) || null,
    skills: [],
    postedAt: card.postedText?.trim() || null,
  };
}

export async function fetchJobStreetJobs(
  options: SearchOptions,
): Promise<SourceFetchResult> {
  const slug = options.query
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  if (!slug) {
    return { jobs: [] };
  }

  const jobs: JobListing[] = [];
  const knownIds = options.knownIds;

  return withBrowserPage(async (page) => {
    for (let pageNum = 1; jobs.length < options.limit; pageNum += 1) {
      const targetUrl = `https://sg.jobstreet.com/${slug}-jobs/in-Singapore?sortmode=ListedDate&page=${pageNum}`;
      const response = await page.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
      });
      if (
        response &&
        (response.status() === 403 || response.status() === 429)
      ) {
        return {
          jobs,
          blockedReason: `HTTP ${response.status()} from JobStreet SG`,
        };
      }

      const blockReason = await detectAntiBotBlock(page);
      if (blockReason) {
        return { jobs, blockedReason: blockReason };
      }

      await page
        .locator('article[data-automation="normalJob"], [data-testid="job-card"]')
        .first()
        .waitFor({ state: 'attached', timeout: 8_000 })
        .catch(() => undefined);

      const remaining = options.limit - jobs.length;
      const rawCards = await page.evaluate((maxItems: number) => {
        const cards = Array.from(
          document.querySelectorAll(
            'article[data-automation="normalJob"], [data-testid="job-card"]',
          ),
        ).slice(0, maxItems);

        return cards.map((card): RawJobStreetCard => {
          const linkEl = (card.querySelector('a[data-automation="jobTitle"]') ??
            card.querySelector('a[href*="/job/"]')) as HTMLAnchorElement | null;
          const href = linkEl?.getAttribute('href') ?? '';
          const url = href.startsWith('http')
            ? href
            : href
              ? `https://sg.jobstreet.com${href}`
              : '';
          const idMatch = url.match(/\/job\/(\d+)/);
          const externalId =
            card.getAttribute('data-job-id') ?? idMatch?.[1] ?? url;
          const title =
            linkEl?.textContent?.trim() ||
            card.getAttribute('aria-label')?.trim() ||
            '';

          const companyEl = card.querySelector('[data-automation="jobCompany"]');
          const locationEl = card.querySelector(
            '[data-automation="jobLocation"]',
          );
          const salaryEl = card.querySelector('[data-automation="jobSalary"]');
          const snippetEl = card.querySelector(
            '[data-automation="jobShortDescription"]',
          );
          const dateEl = card.querySelector(
            '[data-automation="jobListingDate"]',
          );

          return {
            externalId,
            url,
            title,
            company: companyEl?.textContent?.trim() ?? '',
            location: locationEl?.textContent?.trim() ?? 'Singapore',
            salaryText: salaryEl?.textContent?.trim() ?? null,
            snippet: snippetEl?.textContent?.trim() ?? null,
            postedText: dateEl?.textContent?.trim() ?? null,
          };
        });
      }, remaining);

      const pageJobs = rawCards
        .map(normalizeJobStreetCard)
        .filter((job): job is JobListing => job !== null);

      if (pageJobs.length === 0) {
        break;
      }

      let unseenOnPage = 0;
      for (const job of pageJobs) {
        if (!knownIds?.has(job.externalId)) {
          unseenOnPage += 1;
        }
        jobs.push(job);
      }

      // Stop paginating once we hit a page of already-tracked jobs.
      if (knownIds && knownIds.size > 0 && unseenOnPage === 0) {
        break;
      }
    }

    return { jobs };
  });
}

export const jobStreetSource: JobSourcePlugin = {
  id: 'jobstreet',
  aliases: ['js'],
  label: 'JobStreet SG',
  fetch: fetchJobStreetJobs,
};
