// Task and contract helpers: hidden-marker and trailer parsing, contract
// parsing, path globs and tier classification. All pure.

import { parse } from 'yaml';
import type { ContractSnap, MarkerStatus, Tier, TiersPolicy } from './types.ts';

const TASK_ID = /^[a-z0-9][a-z0-9_-]{0,63}(\/[a-z0-9][a-z0-9_-]{0,63}){0,4}$/;
const MARKER = /<!-- factory-task: ([^\s]+) -->/g;

export function isTaskId(value: unknown): value is string {
  return typeof value === 'string' && TASK_ID.test(value);
}

export function contractPath(taskId: string): string {
  if (!isTaskId(taskId)) throw new Error(`invalid task id: ${taskId}`);
  return `contracts/${taskId}.yaml`;
}

/**
 * Reads only the hidden `<!-- factory-task: <id> -->` marker from an issue
 * body. Nothing else in the body is ever used. Several different markers or a
 * malformed id are `invalid` (fail closed).
 */
export function parseTaskMarker(body: string | null | undefined): { task_id: string | null; status: MarkerStatus } {
  if (!body) return { task_id: null, status: 'missing' };
  const found = new Set<string>();
  for (const m of body.matchAll(MARKER)) found.add(m[1]!);
  if (found.size === 0) return { task_id: null, status: 'missing' };
  const [only] = found;
  if (found.size > 1 || !isTaskId(only)) return { task_id: null, status: 'invalid' };
  return { task_id: only, status: 'ok' };
}

export interface PrTrailers {
  task_id: string | null;
  contract_sha: string | null;
  attempt: number | null;
}

function singleTrailer(lines: string[], name: string, pattern: RegExp): string | null {
  const values = new Set<string>();
  for (const line of lines) {
    if (!line.startsWith(`${name}:`)) continue;
    const m = pattern.exec(line.slice(name.length + 1).trim());
    if (!m) return null;
    values.add(m[0]);
  }
  return values.size === 1 ? [...values][0]! : null;
}

/** Parses `Factory-Task:`, `Contract-SHA:` and `Factory-Attempt:` lines. Conflicts → null. */
export function parsePrTrailers(body: string | null | undefined): PrTrailers {
  const lines = (body ?? '').split('\n').map((l) => l.replace(/\r$/, ''));
  const task = singleTrailer(lines, 'Factory-Task', /^[^\s]+$/);
  const sha = singleTrailer(lines, 'Contract-SHA', /^[0-9a-f]{7,40}$/);
  const attempt = singleTrailer(lines, 'Factory-Attempt', /^[1-9][0-9]{0,2}$/);
  return {
    task_id: isTaskId(task) ? task : null,
    contract_sha: sha,
    attempt: attempt === null ? null : Number(attempt),
  };
}

/** A declared Contract-SHA matches if it is a ≥7-hex prefix of the full contract commit SHA. */
export function contractShaMatches(declared: string | null, fullSha: string): boolean {
  if (!declared || !/^[0-9a-f]{7,40}$/.test(declared)) return false;
  if (!/^[0-9a-f]{40}$/.test(fullSha)) return false;
  return fullSha.startsWith(declared);
}

export function invalidContract(path: string, blobSha: string, lastCommitSha: string): ContractSnap {
  return {
    path,
    blob_sha: blobSha,
    last_commit_sha: lastCommitSha,
    valid: false,
    id: null,
    tier: null,
    depends_on: [],
    scope: [],
    priority: null,
    area: null,
  };
}

/** Parses a contract file. Anything unexpected yields `valid: false`. */
export function parseContract(path: string, blobSha: string, lastCommitSha: string, text: string): ContractSnap {
  const bad = invalidContract(path, blobSha, lastCommitSha);
  const m = /^contracts\/(.+)\.yaml$/.exec(path);
  if (!m || !isTaskId(m[1])) return bad;
  if (!/^[0-9a-f]{40}$/.test(lastCommitSha)) return bad;
  let doc: unknown;
  try {
    doc = parse(text);
  } catch {
    return bad;
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return bad;
  const d = doc as Record<string, unknown>;
  if (d.id !== m[1]) return bad;
  const tier = d.tier;
  if (tier !== 'auto' && tier !== 'auto-strict' && tier !== 'human') return bad;
  const deps = d.depends_on ?? [];
  if (!Array.isArray(deps) || !deps.every(isTaskId)) return bad;
  const scope = d.scope;
  if (!Array.isArray(scope) || scope.length === 0 || !scope.every((s) => typeof s === 'string' && s.length > 0)) {
    return bad;
  }
  const priority = d.priority ?? null;
  if (priority !== null && (typeof priority !== 'number' || !Number.isFinite(priority))) return bad;
  const area = d.area ?? null;
  if (area !== null && (typeof area !== 'string' || !/^[a-z0-9/_-]{1,64}$/.test(area))) return bad;
  return {
    path,
    blob_sha: blobSha,
    last_commit_sha: lastCommitSha,
    valid: true,
    id: m[1]!,
    tier,
    depends_on: deps as string[],
    scope: scope as string[],
    priority: priority as number | null,
    area: area as string | null,
  };
}

// ---------------------------------------------------------------- globs & tiers

const GLOB_CHARS = /[*?]/;

export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}

const TIER_RANK: Record<Tier, number> = { auto: 0, 'auto-strict': 1, human: 2 };

export function stricterTier(a: Tier, b: Tier): Tier {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

/** Tier of one path; strictest match wins and unknown paths are `human` (fail closed). */
export function pathTier(path: string, tiers: TiersPolicy): Tier {
  if (matchesAny(path, tiers.tiers.human.paths)) return 'human';
  if (matchesAny(path, tiers.tiers['auto-strict'].paths)) return tiers.tiers['auto-strict'].start_as ?? 'auto-strict';
  if (matchesAny(path, tiers.tiers.auto.paths)) return 'auto';
  return 'human';
}

/** Effective tier = strictest of the contract's own tier and every scope path's tier. */
export function taskTier(contract: ContractSnap, tiers: TiersPolicy): Tier {
  if (!contract.valid || !contract.tier || contract.scope.length === 0) return 'human';
  let tier: Tier = contract.tier;
  for (const p of contract.scope) tier = stricterTier(tier, pathTier(p, tiers));
  return tier;
}

/** Core area = any scope path under the auto-strict paths (src/core/** etc.). */
export function isCoreTask(contract: ContractSnap, tiers: TiersPolicy): boolean {
  return contract.scope.some((p) => matchesAny(p, tiers.tiers['auto-strict'].paths));
}

function literalPrefix(glob: string): string {
  const i = glob.search(GLOB_CHARS);
  return i < 0 ? glob : glob.slice(0, i);
}

/** Conservative overlap test between two scope lists (globs allowed). */
export function scopesOverlap(a: string[], b: string[]): boolean {
  for (const p of a) {
    for (const q of b) {
      if (p === q) return true;
      if (globToRegExp(p).test(q) || globToRegExp(q).test(p)) return true;
      if (GLOB_CHARS.test(p) || GLOB_CHARS.test(q)) {
        const lp = literalPrefix(p);
        const lq = literalPrefix(q);
        if (lp.startsWith(lq) || lq.startsWith(lp)) return true;
      }
    }
  }
  return false;
}

/** Two tasks share an area lock if they declare the same `area` or their scopes overlap. */
export function sameArea(a: ContractSnap, b: ContractSnap): boolean {
  if (a.area !== null && a.area === b.area) return true;
  return scopesOverlap(a.scope, b.scope);
}
