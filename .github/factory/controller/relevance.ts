// Which events start a controller poll (controller.yml `relevance` job). Every poll spends the App
// installation's hourly API quota, which since 2026-11-09 ran out most hours (HTTP 403 for ~15 min):
// PRs nobody in the factory owns (people's `sabbasi/*` branches, an external locale's session) and
// the `ci`/`gates` runs on them started a full poll each. Pure and dependency-free (runs before
// `npm ci`); any doubt means poll, since a skipped poll can only delay the factory, never unsafe it.

/**
 * Head-branch prefixes of every PR factory automation opens or the controller acts on:
 * - `factory/onboard/<code>`       onboard.yml (generated language onboarding)
 * - `factory/intake/<lang>-fix-…`  intake.yml (bug-intake fix PRs)
 * - `factory/deps/<name>-<ver>`    dependency-steward.yml
 * - `factory/upstream/<tag>`       upstream-sync.yml
 * - `factory/revert-<n>`           the controller's auto-revert (executor.ts)
 * - `factory/<task>-<hash>`        gh-aw implement (task PRs; repair pushes to the same branch)
 * - `gh-readonly-queue/`           the merge queue's temporary branches (`merge_group` CI)
 * Task branches have no fixed sub-prefix (gh-aw names them), so `factory/` stays the broad rule;
 * the specific ones are listed so a change to one of them shows up here and in the tests.
 */
export const FACTORY_BRANCH_PREFIXES: readonly string[] = [
  'factory/onboard/',
  'factory/intake/',
  'factory/deps/',
  'factory/upstream/',
  'factory/revert-',
  'factory/',
  'gh-readonly-queue/',
];

/** The factory's Apps: PRs they open belong to the factory whatever the branch (older agent PRs and
 *  drills used unprefixed branches). */
export const FACTORY_BOT_LOGINS: readonly string[] = ['sabbasi3-factory-agent[bot]', 'sabbasi3-factory-controller[bot]'];

const owned = (branch: unknown, login: unknown): boolean =>
  (typeof branch === 'string' && FACTORY_BRANCH_PREFIXES.some((p) => branch.startsWith(p))) ||
  (typeof login === 'string' && FACTORY_BOT_LOGINS.includes(login));

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});

export interface Relevance {
  poll: boolean;
  reason: string;
}

/**
 * Poll, or skip a PR-driven event for a branch no factory automation owns. Kept: `push` (to main),
 * `merge_group`, `issues` (controller.yml filters these to task issues), `schedule`,
 * `workflow_dispatch`, and a `workflow_run` of anything but a PR (ci on main or the merge queue, the
 * reviewer). Unknown events and malformed payloads poll.
 *   prAuthors: for a `workflow_run` of a PR, the logins of the PRs it ran for (the run's `actor` is who
 *   triggered it, e.g. a person pushing to an App's PR, not who opened it). null = unknown: poll.
 */
export function relevance(eventName: string, payload: unknown, prAuthors: readonly string[] | null = null): Relevance {
  const e = rec(payload);
  if (eventName === 'pull_request_target' || eventName === 'pull_request') {
    const pr = rec(e.pull_request);
    const branch = rec(pr.head).ref;
    const login = rec(pr.user).login;
    if (typeof branch !== 'string') return { poll: true, reason: 'pr without a head branch: poll' };
    return owned(branch, login) ? { poll: true, reason: `factory pr ${branch}` } : { poll: false, reason: `pr on ${branch}: no factory automation owns it` };
  }
  if (eventName === 'workflow_run') {
    const run = rec(e.workflow_run);
    const ev = run.event;
    const branch = run.head_branch;
    if (ev === 'pull_request' || ev === 'pull_request_target') {
      if (typeof branch !== 'string') return { poll: true, reason: 'pr run without a head branch: poll' };
      if (owned(branch, null)) return { poll: true, reason: `run on factory branch ${branch}` };
      if (prAuthors === null || prAuthors.length === 0) return { poll: true, reason: `run on ${branch}: its PR's author is unknown, poll` };
      if (prAuthors.some((a) => owned(null, a))) return { poll: true, reason: `run on ${branch}: a factory App's PR` };
      return { poll: false, reason: `run on ${branch}: no factory automation owns it` };
    }
    if (ev === 'push' && typeof branch === 'string' && branch !== 'main' && !owned(branch, null)) {
      return { poll: false, reason: `push run on ${branch}` };
    }
    return { poll: true, reason: `workflow_run (${String(ev)})` };
  }
  return { poll: true, reason: eventName };
}

/** The PR numbers a `workflow_run` ran for (same-repo PRs; empty for others). Pure. */
export function runPrNumbers(payload: unknown): number[] {
  const prs = rec(rec(payload).workflow_run).pull_requests;
  return Array.isArray(prs) ? prs.map((p) => rec(p).number).filter((n): n is number => Number.isInteger(n) && (n as number) > 0) : [];
}

/** Each PR's author (GET /repos/{repo}/pulls/{n}, read-only token); any failure or none: null (poll). */
export async function prAuthorsOf(numbers: readonly number[], repo: string, token: string, fetchFn: typeof fetch = fetch): Promise<string[] | null> {
  if (numbers.length === 0 || !token || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) return null;
  try {
    const out: string[] = [];
    for (const n of numbers.slice(0, 10)) {
      const res = await fetchFn(`https://api.github.com/repos/${repo}/pulls/${n}`, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'User-Agent': 'factory-controller-relevance' } });
      if (!res.ok) return null;
      const login = rec(rec(await res.json()).user).login;
      if (typeof login !== 'string') return null;
      out.push(login);
    }
    return out;
  } catch {
    return null;
  }
}

if (process.argv[1]?.endsWith('relevance.ts') && process.argv[2] !== undefined) {
  const { readFileSync, appendFileSync } = await import('node:fs');
  let payload: unknown = null;
  try {
    payload = JSON.parse(readFileSync(process.argv[3] ?? '', 'utf8'));
  } catch {
    payload = null;
  }
  const authors = process.argv[2] === 'workflow_run' ? await prAuthorsOf(runPrNumbers(payload), process.env.GITHUB_REPOSITORY ?? '', process.env.GH_TOKEN ?? '') : null;
  const r = relevance(process.argv[2], payload, authors);
  console.log(`${r.poll ? 'poll' : 'skip'}: ${r.reason}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `poll=${r.poll}\n`);
}
