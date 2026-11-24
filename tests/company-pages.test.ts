import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { chromium, type Browser } from 'playwright';
import { captureCompanyPage, readCompanyPage } from '../src/sources/playwright/company-pages.js';

describe('Playwright company page evidence', () => {
  let browser: Browser;
  before(async () => { browser = await chromium.launch({ headless: true }); });
  after(async () => { await browser?.close(); });

  it('captures JavaScript-rendered public content and records truncation', async (t) => {
    const page = await browser.newPage();
    t.after(() => page.close());
    await page.route('https://company.example/**', (route) => route.fulfill({
      contentType: 'text/html',
      body: '<title>Company history</title><body><script>document.body.textContent = "Founded by Alice. " + "x".repeat(21000)</script></body>',
    }));
    const evidence = await captureCompanyPage(page, 'https://company.example/about');
    assert.equal(evidence.status, 'retrieved');
    assert.equal(evidence.title, 'Company history');
    assert.equal(evidence.method, 'playwright');
    assert.ok(evidence.text.startsWith('Founded by Alice.'));
    assert.equal(evidence.text.length, 20_000);
    assert.equal(evidence.truncated, true);
    assert.equal(evidence.httpStatus, 200);
  });

  it('records blocked challenges and HTTP failures without reporting successful retrieval', async (t) => {
    const page = await browser.newPage();
    t.after(() => page.close());
    for (const [status, body, expected] of [
      [200, '<title>Humans only</title><body>Verify you are human</body>', 'blocked'],
      [429, '<body>Too many requests</body>', 'blocked'],
      [200, '<title>Sign in</title><body>Sign in to continue</body>', 'blocked'],
      [200, '<title>Security products</title><body>Our software supports CAPTCHA and identity management.</body>', 'retrieved'],
      [404, '<body>Not found</body>', 'unavailable'],
    ] as const) {
      await page.route('https://company.example/**', (route) => route.fulfill({
        status, contentType: 'text/html', body,
      }));
      const evidence = await captureCompanyPage(page, 'https://company.example/about');
      assert.equal(evidence.status, expected);
      assert.equal(evidence.httpStatus, status);
      assert.equal(!!evidence.reason, expected !== 'retrieved');
      await page.unroute('https://company.example/**');
    }
  });

  it('waits for delayed content while ignoring a stalled image request', async (t) => {
    const page = await browser.newPage();
    t.after(() => page.close());
    await page.route('https://company.example/about', (route) => route.fulfill({
      contentType: 'text/html',
      body: '<title>Company</title><body><main>Loading...</main><img src="/slow.png"><script>setTimeout(() => { document.querySelector("main").textContent = "Founded by Alice, a Singapore software company."; }, 200)</script></body>',
    }));
    await page.route('https://company.example/slow.png', () => {});
    const evidence = await captureCompanyPage(page, 'https://company.example/about');
    assert.equal(evidence.status, 'retrieved');
    assert.ok(evidence.text.includes('Founded by Alice'));
    assert.ok(!evidence.text.includes('Loading...'));
  });

  it('returns failure evidence when Chromium cannot launch', async (t) => {
    t.mock.method(chromium, 'launch', async () => { throw new Error('Browser executable missing'); });
    const evidence = await readCompanyPage('https://company.example/about');
    assert.equal(evidence.status, 'unavailable');
    assert.match(evidence.reason!, /Browser executable missing/);
    assert.equal(evidence.text, '');
    assert.equal(evidence.requestedUrl, 'https://company.example/about');
  });

  it('rejects non-web URLs and embedded credentials before launching a browser', async () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'https://user:secret@company.example']) {
      await assert.rejects(readCompanyPage(url), /HTTP\(S\)/);
    }
  });
});
