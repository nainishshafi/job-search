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
