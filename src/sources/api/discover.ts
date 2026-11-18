import fs from 'node:fs';
import path from 'node:path';
import {
  loadBoardConfig,
  type AtsBoardConfig,
  type AtsBoardsFile,
} from './ats.js';

export type AtsPlatform = 'greenhouse' | 'lever';

export interface CandidateToken {
  platform: AtsPlatform;
  token: string;
}

export interface DiscoveredBoard extends AtsBoardConfig {
  platform: AtsPlatform;
  sgJobCount: number;
}

const DEFAULT_BOARDS_PATH = path.resolve(process.cwd(), 'config', 'boards.json');
const IGNORED_TOKENS = new Set([
  'embed',
  'v1',
  'v0',
  'jobs',
  'search',
  'api',
  'assets',
]);
const SG_RE = /\bsingapore\b/i;

export function extractAtsTokensFromText(text: string): CandidateToken[] {
  const decoded = text
    .replace(/&#x2F;|&#47;/gi, '/')
    .replace(/&amp;/g, '&');
  const seen = new Set<string>();
  const out: CandidateToken[] = [];

  const add = (platform: AtsPlatform, rawToken: string) => {
    const token = rawToken.trim().toLowerCase();
    if (!token || IGNORED_TOKENS.has(token)) return;
    const key = `${platform}:${token}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ platform, token });
  };

  for (const m of decoded.matchAll(
    /(?:job-)?boards(?:\.eu)?\.greenhouse\.io\/([a-z0-9_-]+)/gi,
  )) {
    add('greenhouse', m[1]);
  }
  for (const m of decoded.matchAll(/jobs\.lever\.co\/([a-z0-9_-]+)/gi)) {
    add('lever', m[1]);
  }

  return out;
}

export function parseTokenArgs(raw: string): CandidateToken[] {
  const out: CandidateToken[] = [];
  for (const part of raw.split(',')) {
    const item = part.trim().toLowerCase();
    if (!item) continue;
    if (item.startsWith('gh:')) {
      out.push({ platform: 'greenhouse', token: item.slice(3) });
    } else if (item.startsWith('lv:')) {
      out.push({ platform: 'lever', token: item.slice(3) });
    } else {
      out.push({ platform: 'greenhouse', token: item });
      out.push({ platform: 'lever', token: item });
    }
  }
  return out;
}

function formatCompanyName(token: string): string {
  return token
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

async function probeCandidate(
  candidate: CandidateToken,
): Promise<DiscoveredBoard | null> {
  try {
    if (candidate.platform === 'greenhouse') {
      const [boardRes, jobsRes] = await Promise.all([
        fetch(
          `https://boards-api.greenhouse.io/v1/boards/${candidate.token}`,
          { signal: AbortSignal.timeout(10_000) },
        ),
        fetch(
          `https://boards-api.greenhouse.io/v1/boards/${candidate.token}/jobs`,
          { signal: AbortSignal.timeout(10_000) },
        ),
      ]);
      if (!jobsRes.ok) return null;
      const jobsData = (await jobsRes.json()) as {
        jobs?: Array<{ location?: { name?: string } }>;
      };
      const sgJobCount = (jobsData.jobs ?? []).filter((j) =>
        SG_RE.test(j.location?.name ?? ''),
      ).length;
      if (sgJobCount === 0) return null;

      let company = formatCompanyName(candidate.token);
      if (boardRes.ok) {
        const boardData = (await boardRes.json()) as { name?: string };
        if (boardData.name?.trim()) company = boardData.name.trim();
      }
      return { platform: 'greenhouse', token: candidate.token, company, sgJobCount };
    }

    const res = await fetch(
      `https://api.lever.co/v0/postings/${candidate.token}?mode=json`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return null;
    const jobs = (await res.json()) as Array<{
      categories?: { location?: string };
    }>;
    if (!Array.isArray(jobs)) return null;
    const sgJobCount = jobs.filter((j) =>
      SG_RE.test(j.categories?.location ?? ''),
    ).length;
    if (sgJobCount === 0) return null;

    return {
      platform: 'lever',
      token: candidate.token,
      company: formatCompanyName(candidate.token),
      sgJobCount,
    };
  } catch {
    return null;
  }
}

export function mergeBoards(
  existing: AtsBoardsFile,
  discovered: DiscoveredBoard[],
): { merged: AtsBoardsFile; added: DiscoveredBoard[] } {
  const ghSet = new Set(existing.greenhouse.map((b) => b.token.toLowerCase()));
  const lvSet = new Set(existing.lever.map((b) => b.token.toLowerCase()));
  const merged: AtsBoardsFile = {
    greenhouse: [...existing.greenhouse],
    lever: [...existing.lever],
  };
  const added: DiscoveredBoard[] = [];

  for (const item of discovered) {
    const tokenLower = item.token.toLowerCase();
    if (item.platform === 'greenhouse' && !ghSet.has(tokenLower)) {
      ghSet.add(tokenLower);
      merged.greenhouse.push({ token: item.token, company: item.company });
      added.push(item);
    } else if (item.platform === 'lever' && !lvSet.has(tokenLower)) {
      lvSet.add(tokenLower);
      merged.lever.push({ token: item.token, company: item.company });
      added.push(item);
    }
  }

  return { merged, added };
}

export async function discoverBoards(options: {
  tokens?: string;
  url?: string;
  boardsPath?: string;
}): Promise<{ probed: number; added: DiscoveredBoard[] }> {
  const boardsPath = options.boardsPath ?? DEFAULT_BOARDS_PATH;
  const existing = loadBoardConfig(boardsPath);
  const candidates: CandidateToken[] = [];

  if (options.tokens) {
    candidates.push(...parseTokenArgs(options.tokens));
  }

  if (options.url) {
    const res = await fetch(options.url, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`Failed to fetch discovery URL: HTTP ${res.status}`);
    }
    const text = await res.text();
    candidates.push(...extractAtsTokensFromText(text));
  }

  if (!options.tokens && !options.url) {
    const hnQueries = ['greenhouse.io Singapore', 'lever.co Singapore'];
    const hnResponses = await Promise.all(
      hnQueries.map((q) =>
        fetch(
          `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&tags=comment&hitsPerPage=100`,
          { signal: AbortSignal.timeout(15_000) },
        ),
      ),
    );
    for (const hnRes of hnResponses) {
      if (!hnRes.ok) continue;
      const data = (await hnRes.json()) as {
        hits?: Array<{ comment_text?: string; story_url?: string }>;
      };
      const combined = (data.hits ?? [])
        .map((h) => `${h.comment_text ?? ''} ${h.story_url ?? ''}`)
        .join('\n');
      candidates.push(...extractAtsTokensFromText(combined));
    }
  }

  const existingKeys = new Set([
    ...existing.greenhouse.map((b) => `greenhouse:${b.token.toLowerCase()}`),
    ...existing.lever.map((b) => `lever:${b.token.toLowerCase()}`),
  ]);

  const toProbe = candidates.filter(
    (c) => !existingKeys.has(`${c.platform}:${c.token.toLowerCase()}`),
  );

  const results: Array<DiscoveredBoard | null> = [];
  const batchSize = 8;
  for (let i = 0; i < toProbe.length; i += batchSize) {
    const batch = toProbe.slice(i, i + batchSize);
    results.push(...(await Promise.all(batch.map(probeCandidate))));
  }
  const valid = results.filter((r): r is DiscoveredBoard => r !== null);

  const { merged, added } = mergeBoards(existing, valid);
  if (added.length > 0) {
    fs.writeFileSync(boardsPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  }

  return { probed: toProbe.length, added };
}
