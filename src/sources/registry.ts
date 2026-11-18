import { greenhouseSource, leverSource } from './api/ats.js';
import { myCareersFutureSource } from './api/mycareersfuture.js';
import { jobStreetSource } from './playwright/jobstreet.js';
import type { JobFetcher, JobSourcePlugin } from './types.js';

/**
 * Single source of truth for all job boards.
 * To add a new job board, export a JobSourcePlugin and append it here.
 */
export const SOURCE_REGISTRY: JobSourcePlugin[] = [
  greenhouseSource,
  leverSource,
  myCareersFutureSource,
  jobStreetSource,
];

const BY_TOKEN = new Map<string, JobSourcePlugin>();
for (const plugin of SOURCE_REGISTRY) {
  BY_TOKEN.set(plugin.id.toLowerCase(), plugin);
  for (const alias of plugin.aliases) {
    BY_TOKEN.set(alias.toLowerCase(), plugin);
  }
}

export function resolveSourceId(raw: string): string | undefined {
  return BY_TOKEN.get(raw.trim().toLowerCase())?.id;
}

export function resolveSourceIds(raw?: string): string[] {
  if (!raw || !raw.trim()) {
    return SOURCE_REGISTRY.map((p) => p.id);
  }
  const resolved: string[] = [];
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const id = resolveSourceId(trimmed);
    if (!id) {
      throw new Error(`Unknown job source "${trimmed}"`);
    }
    if (!resolved.includes(id)) {
      resolved.push(id);
    }
  }
  return resolved.length > 0 ? resolved : SOURCE_REGISTRY.map((p) => p.id);
}

export function getSourceFetcher(id: string): JobFetcher | undefined {
  return BY_TOKEN.get(id.toLowerCase())?.fetch;
}
