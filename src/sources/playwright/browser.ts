import { chromium, type Browser, type Page } from 'playwright';

const ANTI_BOT_PATTERNS = [
  /just a moment/i,
  /performing security verification/i,
  /verify you are human/i,
  /not a bot/i,
  /captcha/i,
  /cloudflare/i,
  /attention required/i,
  /access denied/i,
];

export async function withBrowserPage<T>(
  fn: (page: Page) => Promise<T>,
): Promise<T> {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({
      headless: process.env.PW_HEADLESS === 'true',
    });
    const context = await browser.newContext({
      locale: 'en-SG',
      timezoneId: 'Asia/Singapore',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    return await fn(page);
  } finally {
    await browser?.close();
  }
}

export async function detectAntiBotBlock(page: Page): Promise<string | null> {
  const title = await page.title();
  const bodySnippet = await page
    .locator('body')
    .innerText()
    .then((text) => text.slice(0, 1500))
    .catch(() => '');

  const combined = `${title}\n${bodySnippet}`;
  for (const pattern of ANTI_BOT_PATTERNS) {
    if (pattern.test(combined)) {
      return `Anti-bot or CAPTCHA challenge detected (${pattern.source})`;
    }
  }
  return null;
}
