export type JobSourceName = string;

export type JobStatus =
  | 'new'
  | 'saved'
  | 'applied'
  | 'interviewing'
  | 'rejected'
  | 'archived';

export type SalaryInterval = 'monthly' | 'annual';

export type ScrapeRunStatus = 'running' | 'success' | 'failed' | 'blocked';

export interface JobListing {
  source: JobSourceName;
  externalId: string;
  url: string;
  title: string;
  company: string;
  location: string;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string;
  salaryInterval: SalaryInterval | null;
  employmentType: string | null;
  descriptionSnippet: string | null;
  skills: string[];
  postedAt: string | null;
}

export interface SearchOptions {
  query: string;
  limit: number;
  days?: number;
  knownIds?: ReadonlySet<string>;
}

export interface SourceFetchResult {
  jobs: JobListing[];
  blockedReason?: string;
}

export type JobFetcher = (options: SearchOptions) => Promise<SourceFetchResult>;

export interface JobSourcePlugin {
  id: string;
  aliases: string[];
  label: string;
  fetch: JobFetcher;
}
