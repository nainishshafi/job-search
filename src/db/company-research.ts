import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { StoredJob } from './client.js';
import { getRecentProjectJobs } from './project-analysis.js';

export interface ResearchSource {
  url: string;
  title: string;
  evidence: string;
}

export interface CompanyResearch {
  version: 1;
  company: string;
  model: string;
  researchedAt: string;
  summary: string;
  identity: string;
  size: 'small' | 'large' | 'unknown';
  glassdoor: {
    status: 'found' | 'not_found' | 'unavailable';
    url: string | null;
    rating: number | null;
    reviewCount: number | null;
    summary: string;
  };
  founders: {
    status: 'found' | 'not_found' | 'not_applicable' | 'unavailable';
    names: string[];
    summary: string;
  };
  queries: string[];
  sources: ResearchSource[];
}

export interface PendingCompany {
  company: string;
  input_hash: string;
  jobs: Array<{ id: number; title: string; url: string; source: string }>;
}

export interface CompanyReview {
  snapshotAt: string;
  days: number;
  company?: string;
  decisions: Array<{ input_hash: string; research: CompanyResearch }>;
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim();
}

function webUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Validate provenance and shape; external claims still require the reviewing LLM to verify sources. */
export function isCompanyResearch(value: unknown, company: string): value is CompanyResearch {
  if (!value || typeof value !== 'object') return false;
  const r = value as CompanyResearch;
  if (r.version !== 1 || r.company !== company || !nonempty(r.model) ||
      !nonempty(r.summary) || !nonempty(r.identity) ||
      !nonempty(r.researchedAt) || !Number.isFinite(Date.parse(r.researchedAt)) ||
      !['small', 'large', 'unknown'].includes(r.size) ||
      !Array.isArray(r.queries) || !r.queries.length || !r.queries.every(nonempty) ||
      !Array.isArray(r.sources) || !r.sources.every((s) =>
        s && webUrl(s.url) && nonempty(s.title) && nonempty(s.evidence))) return false;
  const companyQuery = (query: string) => query.toLowerCase().includes(company.toLowerCase());
  if (!r.queries.some(companyQuery) ||
      !r.queries.some((q) => companyQuery(q) && /glassdoor/i.test(q))) return false;
  const g = r.glassdoor;
  const f = r.founders;
  if (!g || !f || !nonempty(g.summary) || !nonempty(f.summary) ||
      !['found', 'not_found', 'unavailable'].includes(g.status) ||
      !['found', 'not_found', 'not_applicable', 'unavailable'].includes(f.status) ||
      !Array.isArray(f.names) || !f.names.every(nonempty)) return false;
  if (g.url !== null && !webUrl(g.url)) return false;
  if (g.url !== null && !/^(www\.)?glassdoor\.(com|co\.uk|com\.sg|sg|ie|ca|com\.au|co\.in|de|fr|nl|es|it|at|ch|com\.br|com\.mx|co\.nz|com\.hk)$/i.test(new URL(g.url).hostname)) return false;
  if (g.status === 'found') {
    if (!g.url || !/^\/Reviews\//i.test(new URL(g.url).pathname) ||
        !r.sources.some((s) => s.url === g.url)) return false;
    if (g.rating !== null && !(typeof g.rating === 'number' && Number.isFinite(g.rating) &&
        g.rating >= 0 && g.rating <= 5)) return false;
    if (g.reviewCount !== null && !(Number.isInteger(g.reviewCount) && g.reviewCount >= 0)) return false;
  } else if (g.rating !== null || g.reviewCount !== null) return false;
  if (f.status === 'found') {
    if (!f.names.length || !f.names.every((name) =>
      r.sources.some((source) => source.evidence.includes(name)))) return false;
  } else if (f.names.length) return false;
  if (f.status === 'not_applicable' && r.size !== 'large') return false;
  if (r.size !== 'large' && !r.queries.some((q) => companyQuery(q) && /founder/i.test(q))) return false;
  // A source-less result can record an unsuccessful search, but cannot claim identified founders or reviews.
  return r.sources.length > 0 || (g.status !== 'found' && f.status !== 'found' && r.size === 'unknown');
}

export function readCompanyResearch(value: string | null | undefined, company: string): CompanyResearch | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isCompanyResearch(parsed, company) ? parsed : null;
  } catch {
    return null;
  }
}

export function getPendingCompanies(
  db: Database.Database, days: number, now = new Date(), company?: string,
): PendingCompany[] {
  const grouped = new Map<string, StoredJob[]>();
  for (const job of getRecentProjectJobs(db, days, now)) {
    if (company !== undefined && job.company !== company) continue;
    if (readCompanyResearch(job.company_research_json, job.company)) continue;
    const group = grouped.get(job.company);
    if (group) group.push(job);
    else grouped.set(job.company, [job]);
  }
  return [...grouped.entries()].map(([name, jobs]) => {
    const context = jobs.sort((a, b) => a.id - b.id).map((job) => ({
      id: job.id, title: job.title, url: job.url, source: job.source,
    }));
    return {
      company: name,
      input_hash: createHash('sha256').update(JSON.stringify([
        name, jobs.map((job) => [job.id, job.company_research_json ?? null]),
      ])).digest('hex'),
      jobs: context,
    };
  });
}

export function saveCompanyReview(db: Database.Database, value: unknown): {
  updatedCompanies: number; updatedJobs: number; jobs: StoredJob[];
} {
  if (!value || typeof value !== 'object') throw new Error('Expected a company review object');
  const review = value as CompanyReview;
  if (!nonempty(review.snapshotAt) || !Number.isFinite(Date.parse(review.snapshotAt)) ||
      !Number.isInteger(review.days) || review.days <= 0 ||
      (review.company !== undefined && !nonempty(review.company)) || !Array.isArray(review.decisions)) {
    throw new Error('Company review requires snapshotAt, positive days and decisions');
  }
  return db.transaction(() => {
    const pending = getPendingCompanies(db, review.days, new Date(review.snapshotAt), review.company);
    const byCompany = new Map(pending.map((item) => [item.company, item]));
    const seen = new Set<string>();
    for (const decision of review.decisions) {
      const research = decision?.research;
      const item = research && byCompany.get(research.company);
      if (!item || seen.has(research.company) || decision.input_hash !== item.input_hash) {
        throw new Error('Company review contains duplicate, already researched, out-of-scope or changed company');
      }
      if (!isCompanyResearch(research, item.company)) {
        throw new Error(`Invalid web research for ${item.company}`);
      }
      seen.add(item.company);
    }
    if (seen.size !== pending.length) throw new Error('Review must cover every pending company; no partial writes');
    const update = db.prepare('UPDATE jobs SET company_research_json = ? WHERE id = ? AND company = ?');
    let updatedJobs = 0;
    for (const { research } of review.decisions) {
      const serialized = JSON.stringify(research);
      for (const job of byCompany.get(research.company)!.jobs) {
        updatedJobs += update.run(serialized, job.id, research.company).changes;
      }
    }
    return {
      updatedCompanies: seen.size, updatedJobs,
      jobs: getRecentProjectJobs(db, review.days, new Date(review.snapshotAt)),
    };
  })();
}
