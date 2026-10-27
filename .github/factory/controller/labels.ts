// The labels the factory relies on (.github/factory/labels.json, seeded by
// `node scripts/seed-backlog/seed.js labels`). A missing label silently breaks a hand-off: e.g. a
// person can't apply `factory:revert-reviewed` if it doesn't exist (drill D7). The controller checks
// at startup and warns; it never fails a run over it.

import { readFile } from 'node:fs/promises';
import { paginate } from './github.ts';
import type { GitHubClient } from './types.ts';

export async function requiredLabels(): Promise<string[]> {
  const doc = JSON.parse(await readFile(new URL('../labels.json', import.meta.url), 'utf8')) as { labels?: { name?: unknown }[] };
  const names = (doc.labels ?? []).map((l) => l.name).filter((n): n is string => typeof n === 'string' && n.length > 0);
  if (names.length === 0) throw new Error('labels.json lists no labels');
  return names;
}

/** Required labels missing from the repo, or null if the label list couldn't be read. */
export async function missingLabels(client: GitHubClient, repo: string, required: readonly string[]): Promise<string[] | null> {
  try {
    const have = new Set(
      (await paginate(client, `/repos/${repo}/labels?per_page=100`, (d) => (Array.isArray(d) ? d : []))).map((l) => (l as { name?: unknown }).name),
    );
    return required.filter((n) => !have.has(n));
  } catch {
    return null;
  }
}
