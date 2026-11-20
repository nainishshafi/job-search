import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  loadBoardConfig,
  normalizeGreenhouseJob,
  normalizeLeverJob,
} from '../src/sources/api/ats.js';
import {
  extractAtsTokensFromText,
  mergeBoards,
  parseTokenArgs,
} from '../src/sources/api/discover.js';
import { normalizeMcfJob } from '../src/sources/api/mycareersfuture.js';
import {
  buildJobStreetSearchUrl,
  normalizeJobStreetCard,
  parseSgdSalary,
} from '../src/sources/playwright/jobstreet.js';

describe('Job payload normalizers', () => {
  it('normalizes MyCareersFuture API payload and strips HTML', () => {
    const job = normalizeMcfJob({
      uuid: 'abc-123',
      title: 'Platform Engineer',
      postedCompany: { name: 'SG Cloud Pte Ltd' },
      salary: {
        minimum: 7000,
        maximum: 10000,
        type: { salaryType: 'Monthly' },
      },
      employmentTypes: [{ employmentType: 'Permanent' }],
      skills: [{ skill: 'Kubernetes' }, { skill: 'Go' }],
      address: { districts: [{ region: 'Central', location: 'Raffles Place' }] },
      description: '<p>Manage <b>Kubernetes</b> clusters in SG.</p>',
      metadata: { newPostingDate: '2026-11-17' },
    });

    assert.ok(job);
    assert.equal(job.source, 'mycareersfuture');
    assert.equal(job.externalId, 'abc-123');
    assert.equal(job.salaryInterval, 'monthly');
    assert.equal(job.location, 'Raffles Place');
    assert.deepEqual(job.skills, ['Kubernetes', 'Go']);
    assert.equal(job.descriptionSnippet, 'Manage Kubernetes clusters in SG.');
  });

  it('returns null for incomplete MCF payload', () => {
    assert.equal(normalizeMcfJob({ title: 'Missing ID' }), null);
  });

  it('parses JobStreet SGD salary ranges', () => {
    assert.deepEqual(parseSgdSalary('$7,500 - $11,000 per month'), {
      salaryMin: 7500,
      salaryMax: 11000,
      salaryInterval: 'monthly',
    });

    assert.deepEqual(parseSgdSalary('SGD 120,000 per annum'), {
      salaryMin: 120000,
      salaryMax: 120000,
      salaryInterval: 'annual',
    });

    assert.deepEqual(parseSgdSalary(null), {
      salaryMin: null,
      salaryMax: null,
      salaryInterval: null,
    });
  });

  it('normalizes JobStreet card data', () => {
    const job = normalizeJobStreetCard({
      externalId: '889900',
      url: 'https://sg.jobstreet.com/job/889900',
      title: 'Full Stack Developer',
      company: 'FinTech SG',
      location: 'Marina Bay',
      salaryText: '$6,000 - $9,000 per month',
      snippet: 'React + Node.js',
      postedText: '2d ago',
    });

    assert.ok(job);
    assert.equal(job.source, 'jobstreet');
    assert.equal(job.salaryMin, 6000);
    assert.equal(job.salaryMax, 9000);
    assert.equal(job.salaryInterval, 'monthly');
  });

  it('builds ICT-scoped JobStreet URLs preserving special characters like c# and .net', () => {
    assert.equal(
      buildJobStreetSearchUrl('c#', 1),
      'https://sg.jobstreet.com/jobs-in-information-communication-technology/in-Singapore?keywords=c%23&sortmode=ListedDate&page=1',
    );
    assert.equal(
      buildJobStreetSearchUrl('.net', 2),
      'https://sg.jobstreet.com/jobs-in-information-communication-technology/in-Singapore?keywords=.net&sortmode=ListedDate&page=2',
    );
    assert.equal(buildJobStreetSearchUrl('   ', 1), null);
  });

  it('normalizes Greenhouse and Lever jobs and filters non-Singapore locations', () => {
    const sgGh = normalizeGreenhouseJob(
      {
        id: 555,
        title: 'Backend Engineer (Java)',
        absolute_url: 'https://boards.greenhouse.io/stripe/jobs/555',
        location: { name: 'Singapore' },
        content: '&lt;p&gt;Java and distributed systems&lt;/p&gt;',
      },
      'Stripe',
    );
    assert.ok(sgGh);
    assert.equal(sgGh.source, 'greenhouse');
    assert.equal(sgGh.company, 'Stripe');
    assert.equal(sgGh.descriptionSnippet, 'Java and distributed systems');

    const usGh = normalizeGreenhouseJob(
      {
        id: 556,
        title: 'Backend Engineer',
        absolute_url: 'https://boards.greenhouse.io/stripe/jobs/556',
        location: { name: 'San Francisco, CA' },
      },
      'Stripe',
    );
    assert.equal(usGh, null);

    const sgLever = normalizeLeverJob(
      {
        id: 'lev-1',
        text: 'Forward Deployed Software Engineer',
        hostedUrl: 'https://jobs.lever.co/palantir/lev-1',
        categories: { location: 'Singapore', commitment: 'Full-time' },
        descriptionPlain: 'Build data platforms in Java and TypeScript.',
      },
      'Palantir',
    );
    assert.ok(sgLever);
    assert.equal(sgLever.source, 'lever');
    assert.equal(sgLever.employmentType, 'Full-time');
  });

  it('loads ATS boards from config/boards.json', () => {
    const config = loadBoardConfig();
    assert.ok(config.greenhouse.length > 0);
    assert.ok(config.lever.length > 0);
    assert.ok(config.greenhouse.every((b) => b.token && b.company));
  });

  it('extracts and merges ATS board tokens without duplicates', () => {
    const extracted = extractAtsTokensFromText(`
      https://boards.greenhouse.io/grab/jobs/123
      https://job-boards.eu.greenhouse.io/binance/jobs/456
      https://jobs.lever.co/padlet/abc
    `);
    assert.deepEqual(extracted, [
      { platform: 'greenhouse', token: 'grab' },
      { platform: 'greenhouse', token: 'binance' },
      { platform: 'lever', token: 'padlet' },
    ]);

    assert.deepEqual(parseTokenArgs('gh:foo,lv:bar'), [
      { platform: 'greenhouse', token: 'foo' },
      { platform: 'lever', token: 'bar' },
    ]);

    const { merged, added } = mergeBoards(
      { greenhouse: [{ token: 'binance', company: 'Binance' }], lever: [] },
      [
        { platform: 'greenhouse', token: 'binance', company: 'Binance', sgJobCount: 5 },
        { platform: 'lever', token: 'padlet', company: 'Padlet', sgJobCount: 2 },
      ],
    );
    assert.equal(added.length, 1);
    assert.equal(added[0].token, 'padlet');
    assert.equal(merged.greenhouse.length, 1);
    assert.equal(merged.lever.length, 1);
  });
});
