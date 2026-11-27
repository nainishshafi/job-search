import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { chromium } from 'playwright';
import type { StoredJob } from '../src/db/client.js';
import type { CompanyResearch } from '../src/db/company-research.js';
import { rubricHash } from '../src/classifier.js';
import { projectInputHash } from '../src/db/project-analysis.js';
import {
  loadJobRubric, matchesClassification, readJobClassification,
  type ClassificationFilter, type SavedJobClassification,
} from '../src/job-classification.js';
import {
  assertHtmlReportDateOrder,
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
        description_snippet: 'Work on a government project. Pay $& or $$bonus',
        skills_json: '[]',
        posted_at: '1h ago',
        first_seen_at: '2026-11-18 05:00:00',
        last_seen_at: '2026-11-18 05:00:00',
        status: 'new',
        notes: null,
        project_type: 'Government / public sector',
        project_probability: 83,
        project_evidence: 'government project',
        project_analyzed_at: '2026-11-18T12:00:00Z',
        project_analysis_method: 'llm',
        project_analysis_model: 'test-model',
        project_reasoning: 'Model reasoning </script><script>alert(2)</script>',
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
      assert.ok(html.includes('<th>Project Likelihood</th>'));
      assert.ok(html.includes('"projectEstimate":{"label":"Government / public sector","score":83,"evidence":"government project"'));
      assert.ok(!html.includes('</script><script>alert(2)</script>'));
      jobs[0].project_analysis_method = null;
      const pending = generateHtmlReport(jobs, { outPath });
      assert.ok(fs.readFileSync(pending, 'utf8').includes('"label":"Not analyzed","score":null'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('shows readable company details while keeping verification notes and excerpts accessible', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-company-details-'));
    const browser = await chromium.launch({ headless: true });
    try {
      const research: CompanyResearch = {
        version: 1, company: 'Acme', model: 'test-model',
        researchedAt: '2026-11-26T08:00:00Z',
        identity: 'Registry notes for the exact legal employer.',
        summary: 'Acme builds SQL/.NET software for retailers. The employee count is historical and covers the global group.',
        size: 'large',
        glassdoor: {
          status: 'unavailable', url: null, rating: null, reviewCount: null,
          summary: 'Unverified search-snippet opinions do not establish engineering-team conditions.',
        },
        founders: {
          status: 'not_found', names: [], summary: 'Directors were not treated as founders.',
        },
        queries: ['Acme Singapore company', 'Acme Glassdoor reviews', 'Acme founders'],
        sources: [{
          url: 'https://example.com/about', title: 'Company website',
          evidence: 'Acme builds software for retailers. <script>window.injected = true</script>',
        }],
      };
      const job: StoredJob = {
        id: 1, source: 'jobstreet', external_id: '1', url: 'https://example.com/job',
        title: 'Developer', company: 'Acme', location: 'Singapore',
        salary_min: null, salary_max: null, salary_currency: 'SGD', salary_interval: null,
        employment_type: null, description_snippet: null, skills_json: '[]',
        posted_at: '2026-11-26', first_seen_at: '2026-11-26 08:00:00',
        last_seen_at: '2026-11-26 08:00:00', status: 'new', notes: null,
        company_research_json: JSON.stringify(research),
      };
      const outPath = generateHtmlReport([job], { outPath: path.join(tmpDir, 'report.html') });
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.goto(pathToFileURL(outPath).href);
      assert.equal(await page.locator('.company-preview').innerText(), 'Acme builds SQL/.NET software for retailers.');
      await page.getByRole('button', { name: 'View company research for Acme' }).click();
      const dialog = page.getByRole('dialog');
      assert.ok(await dialog.isVisible());
      assert.match(await dialog.innerText(), /Reviews could not be verified/);
      assert.match(await dialog.innerText(), /No founder identified in the available sources/);
      assert.ok(!(await dialog.innerText()).includes(research.identity));
      assert.ok(!(await dialog.innerText()).includes(research.glassdoor.summary));
      assert.ok(!(await dialog.innerText()).includes(research.sources[0].evidence));
      await dialog.getByText('Full overview and verification notes', { exact: true }).click();
      assert.match(await dialog.innerText(), /historical and covers the global group/);
      assert.ok((await dialog.innerText()).includes(research.identity));
      await dialog.getByText('Review search notes', { exact: true }).click();
      assert.ok((await dialog.innerText()).includes(research.glassdoor.summary));
      await dialog.getByText('Supporting excerpt', { exact: true }).click();
      assert.ok((await dialog.innerText()).includes(research.sources[0].evidence));
      assert.equal(await dialog.locator('script').count(), 0);
      assert.equal(await page.evaluate(() => 'injected' in window), false);
      const fits = await dialog.evaluate(element => element.scrollWidth <= element.clientWidth);
      assert.ok(fits, 'Company details overflow on a narrow screen');
      await page.keyboard.press('Escape');
      assert.equal(await dialog.isVisible(), false);
      const legacyPage = await browser.newPage();
      await legacyPage.addInitScript(() => {
        Object.defineProperty(Intl, 'Segmenter', { value: undefined, configurable: true });
      });
      await legacyPage.goto(pathToFileURL(outPath).href);
      assert.equal(await legacyPage.locator('.company-preview').innerText(), research.summary);
      await legacyPage.getByRole('button', { name: 'View company research for Acme' }).click();
      assert.ok(await legacyPage.getByRole('dialog').isVisible());
    } finally {
      await browser.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('keeps descending sorts after filtering and fits expanded details on narrow screens', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-report-layout-'));
    const browser = await chromium.launch({ headless: true });
    try {
      const base: StoredJob = {
        id: 1, source: 'jobstreet', external_id: '1', url: 'https://example.com/job',
        title: 'Developer', company: 'Acme', location: 'Singapore',
        salary_min: 6000, salary_max: 8000, salary_currency: 'SGD', salary_interval: 'monthly',
        employment_type: 'Full-time', description_snippet: 'Long description ' + 'x'.repeat(500),
        skills_json: '[]', posted_at: '1h ago',
        first_seen_at: '2026-11-25 08:00:00', last_seen_at: '2026-11-25 08:00:00',
        status: 'new', notes: null,
      };
      const outPath = generateHtmlReport([
        base,
        { ...base, id: 3, external_id: '3', posted_at: '2026-11-24' },
        { ...base, id: 2, external_id: '2', last_seen_at: '2026-11-26 08:00:00' },
      ], { outPath: path.join(tmpDir, 'report.html'), now: new Date('2026-11-26T08:00:00Z') });
      const page = await browser.newPage();
      await page.goto(pathToFileURL(outPath).href);
      const ids = () => page.locator('#jobsBody tr td:first-child').allTextContents();
      assert.equal(await page.locator('#sortOrder').inputValue(), 'posted-desc');
      assert.deepEqual(await ids(), ['#2', '#1', '#3']);
      const html = fs.readFileSync(outPath, 'utf8');
      assert.doesNotThrow(() => assertHtmlReportDateOrder(html));
      assert.throws(() => assertHtmlReportDateOrder(html.replace('value="posted-desc" selected', 'value="id-desc" selected')), /does not default/);
      const reversed = html.replace(/(<script id="jobs-data" type="application\/json">)([^<]*)/, (_, tag, json) =>
        tag + JSON.stringify(JSON.parse(json).reverse()).replace(/</g, '\\u003c'));
      assert.throws(() => assertHtmlReportDateOrder(reversed), /out of date order/);
      assert.match(await page.locator('#jobsBody tr').first().locator('td[data-label="Posted"]').innerText(), /26 Nov 2026/);
      await page.fill('#searchInput', 'Acme');
      assert.deepEqual(await ids(), ['#2', '#1', '#3']);
      await page.selectOption('#sortOrder', 'id-desc');
      assert.deepEqual(await ids(), ['#3', '#2', '#1']);
      for (const width of [1440, 1024, 768, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await page.locator('#jobsBody details').first().evaluate((element) => {
          (element as HTMLDetailsElement).open = true;
        });
        const widths = await page.evaluate(() => ({
          viewport: window.innerWidth,
          document: document.documentElement.scrollWidth,
          table: document.querySelector('table')!.getBoundingClientRect().width,
          wrapper: document.querySelector('.table-wrap')!.clientWidth,
        }));
        assert.ok(widths.document <= widths.viewport, `Page overflows at ${width}px`);
        assert.ok(widths.table <= widths.wrapper + 1, `Table overflows at ${width}px`);
      }
    } finally {
      await browser.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('serializes validated classifications and matches shared AND and strict filter semantics', async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-classification-report-'));
    const browser = await chromium.launch({ headless: true });
    try {
      const rubric = loadJobRubric();
      const attack = '</script><script>window.injected = true</script><img src=x onerror="window.injected=true"> $$ $& {{CLASSIFICATION_LABELS_JSON}}';
      const base: StoredJob = {
        id: 1, source: 'jobstreet', external_id: '1', url: 'https://example.com/job',
        title: 'Backend Java Python developer', company: 'Acme', location: 'Singapore',
        salary_min: 6000, salary_max: 8000, salary_currency: 'SGD', salary_interval: 'monthly',
        employment_type: null, description_snippet: `Banking APIs ${attack}`, skills_json: '[]',
        posted_at: '2026-11-25', first_seen_at: '2026-11-26 08:00:00',
        last_seen_at: '2026-11-26 08:00:00', status: 'new', notes: null,
      };
      function classified(id: number, domain: string, role: string, technologies: string[]): StoredJob {
        const job = { ...base, id, external_id: String(id) };
        const input_hash = projectInputHash(job);
        const dimension = (label: string) => ({
          label, score: label === 'Unclear' ? null : 90, evidence: attack, reasoning: attack,
        });
        const saved: SavedJobClassification = {
          schemaVersion: 1, rubricVersion: rubric.version, rubricHash: rubricHash(rubric),
          input_hash, classifiedAt: '2026-11-25T08:00:00.000Z', model: attack,
          decision: {
            id, input_hash, domain: dimension(domain), role: dimension(role),
            technology: {
              labels: technologies, score: technologies.includes('Unclear') ? null : 90,
              evidence: attack, reasoning: attack,
            },
          },
        };
        return { ...job, classification_json: JSON.stringify(saved) };
      }
      const jobs = [
        classified(1, 'Banking', 'Backend development', ['Java', 'Python']),
        classified(2, 'Healthcare', 'Frontend development', ['C#/.NET']),
        classified(3, 'Banking', 'Unclear', ['Java']),
        classified(4, 'Banking', 'Backend development', ['Unclear']),
        classified(5, 'Unclear', 'Unclear', ['Unclear']),
        { ...base, id: 6 },
        { ...base, id: 7, classification_json: '{invalid' },
        { ...classified(8, 'Banking', 'Backend development', ['Java']), title: 'Changed source' },
        {
          ...classified(9, 'Banking', 'Backend development', ['Java']),
          classification_json: classified(9, 'Banking', 'Backend development', ['Java'])
            .classification_json!.replace(rubricHash(rubric), 'outdated-rubric'),
        },
      ];
      for (const job of jobs.slice(0, 5)) assert.ok(readJobClassification(job, rubric));
      for (const job of jobs.slice(5)) assert.equal(readJobClassification(job, rubric), null);
      const readFile = t.mock.method(fs, 'readFileSync');
      const outPath = generateHtmlReport(jobs, { outPath: path.join(tmpDir, 'report.html') });
      assert.equal(readFile.mock.calls.filter(call =>
        String(call.arguments[0]) === path.resolve('config/job-classifier.json')).length, 1);
      readFile.mock.restore();
      const html = fs.readFileSync(outPath, 'utf8');
      assert.ok(!html.includes(attack));
      assert.ok(!html.includes('type="application/json">{{CLASSIFICATION_LABELS_JSON}}</script>'));
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(pathToFileURL(outPath).href);
      const serialized = await page.locator('#jobs-data').textContent();
      const data = JSON.parse(serialized!) as Array<{ id: number; classification: SavedJobClassification | null }>;
      for (const job of jobs) {
        assert.deepEqual(data.find(row => row.id === job.id)!.classification, readJobClassification(job, rubric));
      }
      for (const dimension of ['domain', 'role', 'technology'] as const) {
        assert.deepEqual(
          await page.locator(`#${dimension}Filter option`).evaluateAll(options =>
            options.map(option => (option as HTMLOptionElement).value)),
          ['', ...Object.keys(rubric.dimensions[dimension])],
        );
      }
      const ids = async () => (await page.locator('#jobsBody tr td:first-child').allTextContents())
        .map(text => Number(text.slice(1)));
      await page.selectOption('#sortOrder', 'id-desc');
      const cases: ClassificationFilter[] = [
        {}, { strict: true }, { domain: 'Banking' }, { role: 'Backend development' },
        { technology: 'Java' }, { technology: 'Python' }, { technology: 'C#/.NET' },
        { domain: 'Banking', role: 'Backend development', technology: 'Java' },
        { domain: 'Healthcare', role: 'Backend development', technology: 'Python' },
        { domain: 'Unclear' }, { role: 'Unclear' }, { technology: 'Unclear' },
        { domain: 'Banking', role: 'Unclear', technology: 'Java' },
        { domain: 'Unclear', role: 'Unclear', technology: 'Unclear' },
      ];
      for (const filter of cases) {
        for (const strict of [false, true]) {
          await page.selectOption('#domainFilter', filter.domain ?? '');
          await page.selectOption('#roleFilter', filter.role ?? '');
          await page.selectOption('#technologyFilter', filter.technology ?? '');
          await page.locator('#strictClassification').setChecked(strict);
          const expected = jobs.filter(job => matchesClassification(job, { ...filter, strict }, rubric))
            .map(job => job.id).sort((a, b) => b - a);
          assert.deepEqual(await ids(), expected, JSON.stringify({ ...filter, strict }));
          assert.equal(await page.locator('#emptyState').isVisible(), expected.length === 0);
          assert.equal(await page.locator('.stat-value').first().innerText(), String(expected.length));
        }
      }
      await page.selectOption('#domainFilter', 'Banking');
      await page.selectOption('#roleFilter', 'Backend development');
      await page.selectOption('#technologyFilter', 'Python');
      await page.fill('#searchInput', 'Acme');
      await page.selectOption('#salaryFilter', 'with-salary');
      await page.selectOption('#sortOrder', 'posted-desc');
      await page.getByRole('button', { name: 'jobstreet (9)', exact: true }).click();
      assert.deepEqual(await ids(), [1]);
      await page.fill('#searchInput', 'no such job');
      assert.deepEqual(await ids(), []);
      await page.fill('#searchInput', '');
      for (const dimension of ['domain', 'role', 'technology']) {
        await page.selectOption(`#${dimension}Filter`, '');
      }
      await page.selectOption('#salaryFilter', 'all');
      const pending = page.locator('#jobsBody tr').filter({ hasText: 'Changed source' });
      assert.equal(await pending.locator('td[data-label="Classification"]').innerText(), 'Classification pending');
      assert.equal(await pending.locator('button[data-classification-id]').count(), 0);
      const unclear = page.locator('#jobsBody tr').filter({ has: page.locator('button[data-classification-id="5"]') });
      assert.match(await unclear.locator('td[data-label="Classification"]').innerText(), /Domain: Unclear\nRole: Unclear\nTechnology: Unclear/);
      await page.getByRole('button', { name: 'View classification for job 1', exact: true }).click();
      const dialog = page.getByRole('dialog');
      assert.ok(await dialog.isVisible());
      assert.match(await dialog.innerText(), /Java, Python/);
      assert.match(await dialog.innerText(), /Evidence:/);
      assert.match(await dialog.innerText(), /Reasoning:/);
      assert.match(await dialog.innerText(), /Provenance/);
      const saved = readJobClassification(jobs[0], rubric)!;
      for (const value of [attack, saved.input_hash, saved.rubricHash, saved.classifiedAt]) {
        assert.ok((await dialog.innerText()).includes(value));
      }
      assert.equal(await dialog.locator('script, img').count(), 0);
      assert.equal(await page.evaluate(() => 'injected' in window), false);
      assert.ok(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth));
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      assert.equal(await dialog.isVisible(), false);
      await page.getByRole('button', { name: 'View classification for job 5', exact: true }).click();
      assert.ok(!(await dialog.innerText()).includes('Classification pending'));
      assert.ok(!(await dialog.innerText()).includes('% confidence'));
      await page.keyboard.press('Escape');
      assert.equal(await dialog.isVisible(), false);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
