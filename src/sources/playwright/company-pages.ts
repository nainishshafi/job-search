import type { Page } from 'playwright';
import { withBrowserPage } from './browser.js';

export interface CompanyPageEvidence {
  requestedUrl: string;
  url: string;
  title: string;
  fetchedAt: string;
  method: 'playwright';
  status: 'retrieved' | 'blocked' | 'unavailable';
  httpStatus: number | null;
  reason: string | null;
  text: string;
  truncated: boolean;
}

function validateUrl(value: string): void {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Company page URL must use HTTP(S) without embedded credentials');
  }
}

/** Capture visible browser evidence for LLM review; never solve challenges or infer company facts. */
export async function captureCompanyPage(page: Page, url: string): Promise<CompanyPageEvidence> {
  validateUrl(url);
  let httpStatus: number | null = null;
  let reason: string | null = null;
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    httpStatus = response?.status() ?? null;
    // Wait for rendered content, not unrelated images or a nonempty loading shell.
    await page.waitForFunction(() => {
      const root = document.querySelector<HTMLElement>('main, [role="main"], article') ?? document.body;
      const text = root?.innerText.trim();
      return !!text && !root?.matches('[aria-busy="true"]') &&
        !/^(?:loading(?: content)?|please wait)[\s.…!]*$/i.test(text);
    }, undefined, { timeout: 10_000 });
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  const title = await page.title().catch(() => '');
  const content = await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '');
  const challengeTitle = /^(?:humans only|just a moment|access denied|attention required|captcha|security verification)[\s.…!]*$/i;
  const challengeScreen = /(?:^|\n)\s*(?:humans only|verify (?:that )?you are human|performing security verification|please complete (?:the )?captcha|complete (?:the )?captcha to continue)[\s.!…]*(?:\n|$)/i;
  const loginWall = /^(?:sign in|log in|login)(?:\s*[-|:].*)?$/i.test(title.trim()) ||
    /(?:^|\n)\s*(?:sign in|log in) to (?:continue|view|access|read)\b/i.test(content.slice(0, 1500));
  const blocked = [401, 403, 429].includes(httpStatus ?? 0) ||
    challengeTitle.test(title.trim()) || challengeScreen.test(content.slice(0, 1500)) || loginWall;
  if (blocked) reason = `Browser access blocked${httpStatus ? ` (HTTP ${httpStatus})` : ''}; ${loginWall ? 'login required' : 'challenge or access restriction not bypassed'}`;
  else if (!content.trim()) reason ??= 'No readable page content';
  else if (httpStatus !== null && httpStatus >= 400) reason ??= `HTTP ${httpStatus}`;
  return {
    requestedUrl: url, url: page.url(), title, fetchedAt: new Date().toISOString(),
    method: 'playwright',
    status: blocked ? 'blocked' : reason ? 'unavailable' : 'retrieved',
    httpStatus, reason, text: content.slice(0, 20_000), truncated: content.length > 20_000,
  };
}

export async function readCompanyPage(url: string): Promise<CompanyPageEvidence> {
  validateUrl(url);
  try {
    return await withBrowserPage((page) => captureCompanyPage(page, url));
  } catch (error) {
    return {
      requestedUrl: url, url, title: '', fetchedAt: new Date().toISOString(),
      method: 'playwright', status: 'unavailable', httpStatus: null,
      reason: error instanceof Error ? error.message : String(error), text: '', truncated: false,
    };
  }
}
