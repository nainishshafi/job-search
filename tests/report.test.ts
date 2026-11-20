import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { StoredJob } from '../src/db/client.js';
import {
  formatTimestampFilename,
  generateHtmlReport,
  isWithinDays,
  sortJobsByDateDesc,
} from '../src/report/html.js';

describe('HTML report generator', () => {
  it('formats local timestamps for filenames', () => {
    const d = new Date(2026, 10, 18, 9, 5, 3);
    assert.equal(formatTimestampFilename(d), '2026-11-18_09-05-03');
  });

  it('filters posted_at values within N days', () => {
    const now = new Date('2026-11-18T12:00:00Z');
    assert.equal(isWithinDays('45m ago', 7, now), true);
    assert.equal(isWithinDays('23h ago', 7, now), true);
    assert.equal(isWithinDays('7d ago', 7, now), true);
    assert.equal(isWithinDays('8d ago', 7, now), false);
    assert.equal(isWithinDays('2026-11-11', 7, now), true);
    assert.equal(isWithinDays('2026-11-10', 7, now), false);
    assert.equal(isWithinDays('2026-11-17T05:42:07-05:00', 7, now), true);
    assert.equal(isWithinDays('2026-11-05T03:20:43-05:00', 7, now), false);
    assert.equal(isWithinDays(null, 7, now), true);
  });

  it('sorts jobs by posted_at descending (latest on top)', () => {
    const base: Omit<StoredJob, 'id' | 'posted_at' | 'last_seen_at'> = {
      source: 'jobstreet',
      external_id: 'x',
      url: 'https://sg.jobstreet.com/job/1',
      title: 'Dev',
      company: 'Acme',
      location: 'Singapore',
      salary_min: null,
      salary_max: null,
      salary_currency: 'SGD',
      salary_interval: null,
      employment_type: null,
      description_snippet: null,
      skills_json: '[]',
      first_seen_at: '2026-11-18 00:00:00',
      status: 'new',
      notes: null,
    };

    const olderRel: StoredJob = {
      ...base,
      id: 1,
      posted_at: '3d ago',
      last_seen_at: '2026-11-20 08:00:00',
    };
    const isoMiddle: StoredJob = {
      ...base,
      id: 2,
      posted_at: '2026-11-19',
      last_seen_at: '2026-11-19 10:00:00',
    };
    const newestRel: StoredJob = {
      ...base,
      id: 3,
      posted_at: '2h ago',
      last_seen_at: '2026-11-20 08:00:00',
    };
    const latestIso: StoredJob = {
      ...base,
      id: 4,
      posted_at: '2026-11-20T07:30:00Z',
      last_seen_at: '2026-11-20 07:35:00',
    };

    const sorted = sortJobsByDateDesc(
      [olderRel, isoMiddle, newestRel, latestIso],
      new Date('2026-11-20T08:00:00Z'),
    );
    assert.deepEqual(
      sorted.map((j) => j.id),
      [4, 3, 2, 1],
    );
  });

  it('combines date-only posted_at (MCF) with extraction time for sorting', () => {
    const base: Omit<StoredJob, 'id' | 'posted_at' | 'first_seen_at' | 'last_seen_at'> = {
      source: 'mycareersfuture',
      external_id: 'mcf',
      url: 'https://www.mycareersfuture.gov.sg/job/1',
      title: 'Java Dev',
      company: 'Acme',
      location: 'Singapore',
      salary_min: null,
      salary_max: null,
      salary_currency: 'SGD',
      salary_interval: null,
      employment_type: null,
      description_snippet: null,
      skills_json: '[]',
      status: 'new',
      notes: null,
    };

    const mcfEarlierExtraction: StoredJob = {
      ...base,
      id: 10,
      posted_at: '2026-11-20',
      first_seen_at: '2026-11-20 00:30:00',
      last_seen_at: '2026-11-20 00:30:00',
    };
    const mcfLaterExtraction: StoredJob = {
      ...base,
      id: 11,
      posted_at: '2026-11-20',
      first_seen_at: '2026-11-20 01:15:00',
      last_seen_at: '2026-11-20 01:15:00',
    };
    const mcfOlderDateLaterExtraction: StoredJob = {
      ...base,
      id: 12,
      posted_at: '2026-11-19',
      first_seen_at: '2026-11-20 02:00:00',
      last_seen_at: '2026-11-20 02:00:00',
    };

    const sorted = sortJobsByDateDesc([
      mcfOlderDateLaterExtraction,
      mcfEarlierExtraction,
      mcfLaterExtraction,
    ]);
    assert.deepEqual(
      sorted.map((j) => j.id),
      [11, 10, 12],
    );
  });

  it('generates HTML report safely escaping script breakout and $ patterns', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-report-test-'));
    const outPath = path.join(tmpDir, 'report.html');
    const jobs: StoredJob[] = [
      {
        id: 1,
        source: 'jobstreet',
        external_id: 'abc',
        url: 'https://sg.jobstreet.com/job/1',
        title: 'Java Dev </script><script>alert(1)</script>',
        company: 'Acme $$ & $& Corp',
        location: 'Singapore',
        salary_min: 6000,
        salary_max: 8000,
        salary_currency: 'SGD',
        salary_interval: 'monthly',
        employment_type: 'Full-time',
        description_snippet: 'Pay $& or $$bonus',
        skills_json: '[]',
        posted_at: '1h ago',
        first_seen_at: '2026-11-18 05:00:00',
        last_seen_at: '2026-11-18 05:00:00',
        status: 'new',
        notes: null,
      },
    ];

    try {
      const written = generateHtmlReport(jobs, {
        title: 'Test Report',
        filterSummary: '1 job(s)',
        outPath,
        now: new Date('2026-11-18T12:00:00Z'),
      });
      assert.equal(written, path.resolve(outPath));
      const html = fs.readFileSync(written, 'utf-8');
      assert.ok(html.includes('<title>Test Report</title>'));
      assert.ok(!html.includes('</script><script>alert(1)</script>'));
      assert.ok(html.includes('\\u003c/script>'));
      assert.ok(html.includes('Acme $$ & $& Corp'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
