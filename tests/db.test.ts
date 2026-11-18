import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getKnownExternalIds,
  getStats,
  listJobs,
  openDatabase,
  updateJobStatus,
  upsertJobs,
} from '../src/db/client.js';
import { runSearch } from '../src/runner.js';
import {
  getSourceFetcher,
  resolveSourceId,
  resolveSourceIds,
} from '../src/sources/registry.js';
import type { JobListing } from '../src/sources/types.js';

function makeJob(overrides: Partial<JobListing> = {}): JobListing {
  return {
    source: 'mycareersfuture',
    externalId: 'mcf-123',
    url: 'https://www.mycareersfuture.gov.sg/job/it/backend-mcf-123',
    title: 'Senior Backend Engineer',
    company: 'Acme SG Pte Ltd',
    location: 'Singapore',
    salaryMin: 8000,
    salaryMax: 12000,
    salaryCurrency: 'SGD',
    salaryInterval: 'monthly',
    employmentType: 'Full Time',
    descriptionSnippet: 'Build scalable TypeScript services.',
    skills: ['TypeScript', 'SQLite'],
    postedAt: '2026-11-18',
    ...overrides,
  };
}

describe('SQLite job tracker', () => {
  it('deduplicates re-runs and preserves user status and notes', () => {
    const db = openDatabase(':memory:');
    try {
      const first = upsertJobs(db, [makeJob()]);
      assert.deepEqual(first, { total: 1, inserted: 1, updated: 0 });

      const [stored] = listJobs(db);
      assert.equal(stored.status, 'new');

      const ok = updateJobStatus(db, stored.id, 'applied', 'Referred by Alex');
      assert.equal(ok, true);

      const second = upsertJobs(db, [
        makeJob({
          title: 'Staff Backend Engineer',
          salaryMax: 14000,
        }),
      ]);
      assert.deepEqual(second, { total: 1, inserted: 0, updated: 1 });

      const jobsAfter = listJobs(db);
      assert.equal(jobsAfter.length, 1);
      assert.equal(jobsAfter[0].title, 'Staff Backend Engineer');
      assert.equal(jobsAfter[0].salary_max, 14000);
      assert.equal(jobsAfter[0].status, 'applied');
      assert.equal(jobsAfter[0].notes, 'Referred by Alex');
    } finally {
      db.close();
    }
  });

  it('isolates source failures and blocked responses in runSearch', async () => {
    const db = openDatabase(':memory:');
    try {
      const reports = await runSearch(db, {
        query: 'Software Engineer',
        sources: ['mycareersfuture', 'jobstreet'],
        limit: 10,
        fetchers: {
          mycareersfuture: async () => ({
            jobs: [makeJob({ externalId: 'mcf-ok-1' })],
          }),
          jobstreet: async () => ({
            jobs: [],
            blockedReason: 'CAPTCHA detected',
          }),
        },
      });

      assert.equal(reports.length, 2);
      assert.equal(reports[0].status, 'success');
      assert.equal(reports[0].jobsNew, 1);
      assert.equal(reports[1].status, 'blocked');
      assert.equal(reports[1].error, 'CAPTCHA detected');

      const stats = getStats(db);
      assert.equal(stats.recentRuns.length, 2);
      assert.equal(listJobs(db).length, 1);
    } finally {
      db.close();
    }
  });

  it('records failed status when a fetcher throws', async () => {
    const db = openDatabase(':memory:');
    try {
      const reports = await runSearch(db, {
        query: 'DevOps',
        sources: ['mycareersfuture'],
        limit: 5,
        fetchers: {
          mycareersfuture: async () => {
            throw new Error('Network timeout');
          },
        },
      });

      assert.equal(reports[0].status, 'failed');
      assert.equal(reports[0].error, 'Network timeout');
    } finally {
      db.close();
    }
  });

  it('passes knownIds to fetchers on repeat runs', async () => {
    const db = openDatabase(':memory:');
    try {
      let seenCountOnSecondRun = -1;

      await runSearch(db, {
        query: 'Java',
        sources: ['mycareersfuture'],
        limit: 10,
        fetchers: {
          mycareersfuture: async () => ({
            jobs: [makeJob({ externalId: 'mcf-seen-1' })],
          }),
        },
      });

      assert.equal(getKnownExternalIds(db, 'mycareersfuture').has('mcf-seen-1'), true);

      await runSearch(db, {
        query: 'Java',
        sources: ['mycareersfuture'],
        limit: 10,
        fetchers: {
          mycareersfuture: async (opts) => {
            seenCountOnSecondRun = opts.knownIds?.size ?? 0;
            return { jobs: [] };
          },
        },
      });

      assert.equal(seenCountOnSecondRun, 1);
    } finally {
      db.close();
    }
  });

  it('resolves source plugins and aliases from the central registry', () => {
    assert.equal(resolveSourceId('mcf'), 'mycareersfuture');
    assert.equal(resolveSourceId('GH'), 'greenhouse');
    assert.equal(resolveSourceId('unknown-board'), undefined);
    assert.deepEqual(resolveSourceIds('gh,js'), ['greenhouse', 'jobstreet']);
    assert.throws(() => resolveSourceIds('gh,unknown-board'), /Unknown job source/);
    assert.ok(getSourceFetcher('mycareersfuture'));
    assert.equal(getSourceFetcher('unknown-board'), undefined);
  });
});
