// Thin GitHub REST/GraphQL client (built-in fetch) and the snapshot reader.
// The client refuses every mutating request except the Git Data API writes to the audit branch,
// plus, in live mode only, the exact writes in liveWriteAllowed (executor.ts lists the effects).

import { createHash } from 'node:crypto';
import { AUDIT_BRANCH, isoSeconds } from './audit.ts';
import { isTaskId, parseContract, parsePrTrailers, parseTaskMarker, contractPath } from './tasks.ts';
import type {
  ApiResponse,
  CheckEvent,
  CodeScanningSnap,
  CheckRunSnap,
  ContractSnap,
  GitHubClient,
  HttpMethod,
  InfraIncidentIssueSnap,
  InfraIncidentSnap,
  IssueSnap,
  MergeQueueEventSnap,
  PullSnap,
  PullState,
  RepairRunSnap,
  RequestOptions,
  ReviewCheckSnap,
  ReviewSnap,
  Snapshot,
} from './types.ts';

export const API_BASE = 'https://api.github.com';
export const MAX_PAGES = 40;
export const CI_WORKFLOW_NAME = 'ci';
export const GATES_WORKFLOW_NAME = 'gates';
/** Fire drills (drills.yml, dispatched by drill-schedule.yml): recorded as check_result only, so every drill result is in the audit log. The planner ignores them. */
export const DRILLS_WORKFLOW_NAME = 'drills';
/** Gate workflows recorded as check_result, and the events each one runs on. */
const CHECK_WORKFLOWS: Record<string, readonly string[]> = {
  [CI_WORKFLOW_NAME]: ['pull_request', 'merge_group', 'push'],
  [GATES_WORKFLOW_NAME]: ['pull_request_target', 'merge_group'],
  [DRILLS_WORKFLOW_NAME]: ['workflow_dispatch'],
};
export const CHECKS_JOB_NAME = 'checks';

export class GitHubApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------- write guard

/**
 * The only GraphQL mutation live mode may send, byte for byte, with one PR node id and the
 * planned head: GitHub refuses it if the PR's head moved since planning.
 */
export const ENQUEUE_MUTATION = 'mutation($id: ID!, $head: GitObjectID!) { enqueuePullRequest(input: {pullRequestId: $id, expectedHeadOid: $head}) { mergeQueueEntry { id } } }';

/** The workflows live mode may dispatch, on `main` only. */
export const IMPLEMENT_WORKFLOW = 'implement.lock.yml';
/** This controller's own workflow (follow-up polls, follow-up.ts). */
export const CONTROLLER_WORKFLOW = 'controller.yml';
export const REVIEW_WORKFLOW = 'review.lock.yml';
/** The needs-human pre-triage agent (triage.md). */
export const TRIAGE_WORKFLOW = 'triage.lock.yml';
/**
 * The reviewer App (`sabbasi3-factory-reviewer`): the only author whose `factory-review` check
 * runs count. Pinned in code, so changing a repository or org variable can't redirect it.
 */
export const REVIEWER_APP_ID = 5444751;
/** The reviewer agent's check run (review.md `safe-outputs.create-check-run.name`). */
export const REVIEW_CHECK_NAME = 'factory-review';
export const REPAIR_WORKFLOW = 'repair.lock.yml';
/**
 * The only labels live mode may add. `factory:ready` only through auto-ready (planner: only with
 * limits.yaml `auto_ready: true`, only on unblocked autonomous-tier task issues).
 */
export const LIVE_LABELS: readonly string[] = ['factory:picked', 'factory:ready', 'needs-human', 'blocked', 'stale-contract'];
/** The only labels live mode may remove, and only from a finished task's issue (close_task). */
export const DONE_REMOVED_LABELS: readonly string[] = ['factory:ready', 'factory:picked'];
const LABEL_READY_NAME = 'factory:ready';
/** The only issue update live mode may send: close a finished task's issue as completed. */
export const CLOSE_COMPLETED = { state: 'closed', state_reason: 'completed' } as const;

/** Auto-revert (auto-strict): the controller's revert branches and PRs (fixed templates). */
export const CONTROLLER_LOGIN = 'sabbasi3-factory-controller';
export const REVERT_BRANCH = (pr: number): string => `factory/revert-${pr}`;
export const REVERT_TITLE = (pr: number): string => `Revert #${pr} (factory auto-revert)`;
/** Added only by a person, on a revert PR: allows the next auto-revert (never in LIVE_LABELS). */
export const REVERT_REVIEWED_LABEL = 'factory:revert-reviewed';
const REVERT_BRANCH_RE = /^factory\/revert-([1-9][0-9]{0,8})$/;
export const revertedPrOf = (branch: string | null | undefined): number | null => {
  const m = REVERT_BRANCH_RE.exec(branch ?? '');
  return m ? Number(m[1]) : null;
};

/** A bug-intake fix PR's branch (harness/feedback): `factory/intake/<lang>-fix-<8 hex>`. */
const INTAKE_BRANCH_RE = /^factory\/intake\/([a-z]{2})-fix-([0-9a-f]{8})$/;
/**
 * The fix id of a bug-intake fix PR (`<lang>/fix-<hash>`): its branch, opened by the controller App.
 * Null for anything else.
 */
export function intakeFixOf(pr: { head_ref?: string | null; author: string | null; author_is_bot: boolean }): string | null {
  const m = INTAKE_BRANCH_RE.exec(pr.head_ref ?? '');
  if (!m || !pr.author_is_bot || (pr.author ?? '').replace(/\[bot\]$/, '') !== CONTROLLER_LOGIN) return null;
  return `${m[1]}/fix-${m[2]}`;
}

/** A language-onboarding PR's branch (harness/onboard, onboard.yml): `factory/onboard/<code>`. */
const ONBOARD_BRANCH_RE = /^factory\/onboard\/([a-z]{2}(?:-[a-z]{4})?)$/;
/** The locale code of a generated onboarding PR, opened by the controller App; null for anything else. */
export function onboardingOf(pr: { head_ref?: string | null; author: string | null; author_is_bot: boolean }): string | null {
  const m = ONBOARD_BRANCH_RE.exec(pr.head_ref ?? '');
  if (!m || !pr.author_is_bot || (pr.author ?? '').replace(/\[bot\]$/, '') !== CONTROLLER_LOGIN) return null;
  return m[1]!;
}

/**
 * Up to `perPage` changed files of a PR with their status; null if unreadable (the planner then waits).
 * A full page may hide more files, so it ends with a `too_many` entry no file check accepts.
 */
export async function readPullFiles(client: GitHubClient, repo: string, n: number, perPage = 10): Promise<{ path: string; status: string }[] | null> {
  try {
    const res = await client.request('GET', `/repos/${repo}/pulls/${n}/files?per_page=${perPage}`);
    if (!Array.isArray(res.data)) return null;
    const files = res.data.map((f) => ({ path: asStr(asRec(f).filename) ?? '', status: asStr(asRec(f).status) ?? '' }));
    return perPage > 10 && files.length >= perPage ? [...files, { path: '', status: 'too_many' }] : files;
  } catch {
    return null;
  }
}

/** The org Project (v2) whose "Factory status" field the controller keeps in sync. */
export const FACTORY_PROJECT_NUMBER = 1;
export const FACTORY_STATUS_FIELD = 'Factory status';
/**
 * The only Project mutation live mode may send, byte for byte: set one item's single-select
 * field to one option. The controller only ever passes the "Factory status" field of Project 1.
 */
export const PROJECT_STATUS_MUTATION = 'mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) { updateProjectV2ItemFieldValue(input: {projectId: $project, itemId: $item, fieldId: $field, value: {singleSelectOptionId: $option}}) { projectV2Item { id } } }';
/** Every comment live mode posts starts with this and comes from a fixed template (no agent text). */
export const COMMENT_MARKER = '**Factory controller**';
/** A spend-bound alert for a person (watchdog, dashboard). */
export const LABEL_ALERT = 'factory:alert';
export type AlertCode = 'overshoot_assumption_exceeded' | 'overshoot_unverifiable' | 'lock_caps_mismatch';
const ALERT_TEXT: Record<AlertCode, string> = {
  overshoot_assumption_exceeded: 'a run broke an overshoot assumption',
  overshoot_unverifiable: "a run's usage records can't be checked against the overshoot assumptions",
  lock_caps_mismatch: 'compiled workflow caps differ from budgets.yaml',
};
export const ALERT_TITLE = (code: AlertCode): string => `Factory alert: ${ALERT_TEXT[code]} (spend bound off)`;
export const ALERT_TITLES: readonly string[] = (Object.keys(ALERT_TEXT) as AlertCode[]).map(ALERT_TITLE);
export const MAX_COMMENT_LENGTH = 2000;

export type ControllerMode = 'dry-run' | 'live';

const exactKeys = (o: unknown, keys: string[]): o is Record<string, unknown> =>
  o !== null && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).sort().join(',') === [...keys].sort().join(',');

/**
 * Live-mode writes: exactly a dispatch of implement on main, adding allowed labels, a templated
 * comment, and for a finished task: removing `factory:ready`/`factory:picked` and closing the
 * issue as completed.
 */
function liveWriteAllowed(repo: string, method: HttpMethod, p: string, b: unknown): boolean {
  const issue = `^/repos/${escapeRe(repo)}/issues/[1-9][0-9]{0,8}`;
  if (method === 'DELETE') {
    const m = new RegExp(`${issue}/labels/([^/]+)$`).exec(p);
    return m !== null && b === undefined && DONE_REMOVED_LABELS.map(encodeURIComponent).includes(m[1]!);
  }
  if (method === 'PATCH') {
    return new RegExp(`${issue}$`).test(p) && exactKeys(b, ['state', 'state_reason']) && b.state === CLOSE_COMPLETED.state && b.state_reason === CLOSE_COMPLETED.state_reason;
  }
  if (method !== 'POST') return false;
  // Confirming a post-merge failure: re-run one workflow run, with no options.
  if (new RegExp(`^/repos/${escapeRe(repo)}/actions/runs/[1-9][0-9]{0,19}/rerun$`).test(p)) return b === undefined;
  // Auto-revert: create the revert branch (only `factory/revert-<n>`), and open its PR from the template.
  if (p === `/repos/${repo}/git/refs`) {
    return exactKeys(b, ['ref', 'sha']) && typeof b.ref === 'string' && REVERT_BRANCH_RE.test(b.ref.replace(/^refs\/heads\//, '')) && b.ref.startsWith('refs/heads/') && typeof b.sha === 'string' && HEX40.test(b.sha);
  }
  // factory:alert: one templated issue for a spend-bound alert (exact title from the alert codes).
  if (p === `/repos/${repo}/issues`) {
    return (
      exactKeys(b, ['title', 'body', 'labels']) &&
      typeof b.title === 'string' && ALERT_TITLES.includes(b.title) &&
      typeof b.body === 'string' && b.body.startsWith(COMMENT_MARKER) && b.body.length <= MAX_COMMENT_LENGTH &&
      Array.isArray(b.labels) && b.labels.length === 1 && b.labels[0] === LABEL_ALERT
    );
  }
  if (p === `/repos/${repo}/pulls`) {
    if (!exactKeys(b, ['title', 'head', 'base', 'body']) || b.base !== 'main' || typeof b.head !== 'string') return false;
    const n = revertedPrOf(b.head);
    return n !== null && b.title === REVERT_TITLE(n) && typeof b.body === 'string' && b.body.startsWith(COMMENT_MARKER) && b.body.length <= MAX_COMMENT_LENGTH;
  }
  // Needs-human pre-triage (triage.md): exactly its six inputs, each in its validated shape.
  if (p === `/repos/${repo}/actions/workflows/${TRIAGE_WORKFLOW}/dispatches`) {
    if (!exactKeys(b, ['ref', 'inputs']) || b.ref !== 'main') return false;
    const i = b.inputs;
    return (
      exactKeys(i, ['task', 'issue', 'pr', 'reason', 'run_id', 'failure_signature']) &&
      isTaskId(i.task) &&
      typeof i.issue === 'string' && /^[1-9][0-9]{0,8}$/.test(i.issue) &&
      typeof i.pr === 'string' && /^(0|[1-9][0-9]{0,8})$/.test(i.pr) &&
      typeof i.reason === 'string' && /^[a-z_]{1,60}$/.test(i.reason) &&
      typeof i.run_id === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(i.run_id) &&
      typeof i.failure_signature === 'string' && /^((step|job):[a-z0-9_-]{1,100})?$/.test(i.failure_signature)
    );
  }
  if (p === `/repos/${repo}/actions/workflows/${REVIEW_WORKFLOW}/dispatches`) {
    if (!exactKeys(b, ['ref', 'inputs']) || b.ref !== 'main') return false;
    const i = b.inputs;
    return (
      exactKeys(i, ['task', 'pr', 'head_sha', 'contract_sha']) &&
      isTaskId(i.task) &&
      typeof i.pr === 'string' && /^[1-9][0-9]{0,8}$/.test(i.pr) &&
      typeof i.head_sha === 'string' && HEX40.test(i.head_sha) &&
      typeof i.contract_sha === 'string' && HEX40.test(i.contract_sha)
    );
  }
  if (p === `/repos/${repo}/actions/workflows/${REPAIR_WORKFLOW}/dispatches`) {
    if (!exactKeys(b, ['ref', 'inputs']) || b.ref !== 'main') return false;
    const i = b.inputs;
    return (
      exactKeys(i, ['task', 'issue', 'pr', 'attempt', 'contract_sha', 'head_sha', 'failure_signature', 'run_id']) &&
      isTaskId(i.task) &&
      typeof i.issue === 'string' && /^[1-9][0-9]{0,8}$/.test(i.issue) &&
      typeof i.pr === 'string' && /^[1-9][0-9]{0,8}$/.test(i.pr) &&
      typeof i.attempt === 'string' && /^[2-9]$/.test(i.attempt) &&
      typeof i.contract_sha === 'string' && HEX40.test(i.contract_sha) &&
      typeof i.head_sha === 'string' && HEX40.test(i.head_sha) &&
      typeof i.failure_signature === 'string' && /^(step|job):[a-z0-9_-]{1,100}$/.test(i.failure_signature) &&
      typeof i.run_id === 'string' && /^[1-9][0-9]{0,19}$/.test(i.run_id)
    );
  }
  // A follow-up poll of the controller itself on main: only a `chain` position 1..24 (follow-up.ts).
  if (p === `/repos/${repo}/actions/workflows/${CONTROLLER_WORKFLOW}/dispatches`) {
    return exactKeys(b, ['ref', 'inputs']) && b.ref === 'main' && exactKeys(b.inputs, ['chain']) && typeof b.inputs.chain === 'string' && /^([1-9]|1[0-9]|2[0-4])$/.test(b.inputs.chain);
  }
  if (p === `/repos/${repo}/actions/workflows/${IMPLEMENT_WORKFLOW}/dispatches`) {
    if (!exactKeys(b, ['ref', 'inputs']) || b.ref !== 'main') return false;
    const i = b.inputs;
    return (
      exactKeys(i, ['task', 'issue', 'attempt', 'contract_sha']) &&
      isTaskId(i.task) &&
      typeof i.issue === 'string' && /^[1-9][0-9]{0,8}$/.test(i.issue) &&
      typeof i.attempt === 'string' && /^[1-9][0-9]?$/.test(i.attempt) &&
      typeof i.contract_sha === 'string' && HEX40.test(i.contract_sha)
    );
  }
  if (new RegExp(`^/repos/${escapeRe(repo)}/issues/[1-9][0-9]{0,8}/labels$`).test(p)) {
    if (!exactKeys(b, ['labels']) || !Array.isArray(b.labels) || b.labels.length === 0) return false;
    // `factory:ready` only on its own (auto-ready adds nothing else with it); the executor checks
    // the issue is an open factory task first.
    if (b.labels.includes(LABEL_READY_NAME)) return b.labels.length === 1;
    return b.labels.every((l) => typeof l === 'string' && LIVE_LABELS.includes(l));
  }
  if (new RegExp(`^/repos/${escapeRe(repo)}/issues/[1-9][0-9]{0,8}/comments$`).test(p)) {
    return exactKeys(b, ['body']) && typeof b.body === 'string' && b.body.startsWith(COMMENT_MARKER) && b.body.length <= MAX_COMMENT_LENGTH;
  }
  return false;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const NODE_ID = (prefix: string): RegExp => new RegExp(`^${prefix}_[A-Za-z0-9_-]{1,80}$`);
function projectStatusVariables(v: unknown): boolean {
  return (
    exactKeys(v, ['project', 'item', 'field', 'option']) &&
    typeof v.project === 'string' && NODE_ID('PVT').test(v.project) &&
    typeof v.item === 'string' && NODE_ID('PVTI').test(v.item) &&
    typeof v.field === 'string' && NODE_ID('PVTSSF').test(v.field) &&
    typeof v.option === 'string' && /^[0-9a-f]{6,40}$/.test(v.option)
  );
}

/**
 * Throws unless the request is read-only, one of the audit-branch Git Data writes (blob, tree,
 * commit, fast-forward ref update/creation of `audit`), or, in live mode only, one of the live
 * writes above (and the two exact GraphQL mutations). Everything else (merge, other closes or
 * issue edits, other label removals, other workflows, other refs) is refused in both modes.
 */
export function assertAllowedRequest(repo: string, method: HttpMethod, path: string, body?: unknown, mode: ControllerMode = 'dry-run'): void {
  const p = path.split('?')[0] ?? '';
  if (method === 'GET') return;
  const b = (body ?? {}) as Record<string, unknown>;
  if (method === 'POST' && p === '/graphql') {
    const q = b.query;
    if (mode === 'live' && q === ENQUEUE_MUTATION && exactKeys(b, ['query', 'variables']) && exactKeys(b.variables, ['id', 'head']) && typeof b.variables.id === 'string' && /^PR_[A-Za-z0-9_-]{1,80}$/.test(b.variables.id) && typeof b.variables.head === 'string' && HEX40.test(b.variables.head)) return;
    if (mode === 'live' && q === PROJECT_STATUS_MUTATION && exactKeys(b, ['query', 'variables']) && projectStatusVariables(b.variables)) return;
    if (typeof q === 'string' && /^\s*(query\b|\{)/.test(q) && !/\bmutation\b/i.test(q)) return;
    throw new Error('refusing GraphQL request that is not a read-only query');
  }
  const git = `/repos/${repo}/git`;
  if (method === 'POST' && (p === `${git}/blobs` || p === `${git}/trees` || p === `${git}/commits`)) return;
  if (method === 'PATCH' && p === `${git}/refs/heads/${AUDIT_BRANCH}` && b.force === false) return;
  if (method === 'POST' && p === `${git}/refs` && b.ref === `refs/heads/${AUDIT_BRANCH}`) return;
  if (mode === 'live' && liveWriteAllowed(repo, method, p, body)) return;
  throw new Error(
    mode === 'live'
      ? `refusing ${method} ${p}: not one of the controller's allowed writes`
      : `refusing ${method} ${p}: the controller is in dry-run mode and only writes the audit branch`,
  );
}

// ---------------------------------------------------------------- client

export function nextPathFromLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (!m) continue;
    const url = new URL(m[1]!);
    if (url.origin !== API_BASE) throw new Error('pagination link points outside the GitHub API');
    return `${url.pathname}${url.search}`;
  }
  return null;
}

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;
export type SleepFn = (ms: number) => Promise<void>;

/** Transient GitHub errors worth another try (bad gateway, unavailable, gateway timeout). */
export const RETRY_STATUSES: readonly number[] = [502, 503, 504];
/** Tries in total for a retryable read; after the last, the error stands (the run fails closed). */
export const MAX_TRIES = 3;
const BASE_DELAY_MS = 1000;

/**
 * Only reads are retried: GET, and POST /graphql with a read-only query (the same test as the
 * allowlist). A write is never retried: a 5xx doesn't say whether it took effect.
 */
export function isRetryableRead(method: HttpMethod, path: string, body: unknown): boolean {
  if (method === 'GET') return true;
  if (method !== 'POST' || path !== '/graphql' || body === null || typeof body !== 'object') return false;
  const q = (body as { query?: unknown }).query;
  return typeof q === 'string' && /^\s*(query\b|\{)/.test(q) && !/\bmutation\b/i.test(q);
}

/** Exponential backoff with full jitter: try n (1-based) waits up to BASE * 2^(n-1). */
export function retryDelayMs(tryNumber: number, random: () => number = Math.random): number {
  return Math.floor(random() * BASE_DELAY_MS * 2 ** (tryNumber - 1)) + 250;
}

const realSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createClient(token: string, repo: string, fetchFn: FetchFn = fetch, mode: ControllerMode = 'dry-run', sleep: SleepFn = realSleep): GitHubClient {
  if (!token) throw new Error('GitHub token missing');
  return {
    async request(method: HttpMethod, path: string, options: RequestOptions = {}): Promise<ApiResponse> {
      if (!path.startsWith('/')) throw new Error('request path must start with /');
      assertAllowedRequest(repo, method, path, options.body, mode);
      const raw = options.accept === 'raw';
      const binary = options.accept === 'binary';
      const headers: Record<string, string> = {
        Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'factory-controller-v1',
      };
      const init: RequestInit = { method, headers, redirect: 'follow' };
      if (options.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(options.body);
      }
      const retryable = isRetryableRead(method, path, options.body);
      let res = await fetchFn(`${API_BASE}${path}`, init);
      for (let tryNumber = 1; retryable && tryNumber < MAX_TRIES && RETRY_STATUSES.includes(res.status); tryNumber++) {
        await res.body?.cancel();
        await sleep(retryDelayMs(tryNumber));
        res = await fetchFn(`${API_BASE}${path}`, init);
      }
      if (options.allowStatuses?.includes(res.status)) {
        await res.body?.cancel();
        return { status: res.status, data: null, next: null };
      }
      if (!res.ok) {
        await res.body?.cancel();
        // A spent hourly quota answers 403/429 with x-ratelimit-remaining: 0: say so (and when it resets).
        const reset = Number(res.headers.get('x-ratelimit-reset'));
        const spent = (res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0';
        const why = spent ? ` (API rate limit spent${Number.isFinite(reset) && reset > 0 ? `; resets ${new Date(reset * 1000).toISOString()}` : ''})` : '';
        throw new GitHubApiError(res.status, `${method} ${path.split('?')[0]}: HTTP ${res.status}${why}`);
      }
      let data: unknown = null;
      if (raw) data = await res.text();
      else if (binary) data = new Uint8Array(await res.arrayBuffer());
      else if (res.status !== 204) data = await res.json();
      return { status: res.status, data, next: nextPathFromLink(res.headers.get('link')) };
    },
  };
}

/** The token's core REST quota (`GET /rate_limit` itself doesn't count against it). */
export interface RateLimit {
  limit: number;
  remaining: number;
  used: number;
  /** Epoch seconds. */
  reset: number;
}

export async function readRateLimit(client: GitHubClient): Promise<RateLimit> {
  const core = (((await client.request('GET', '/rate_limit')).data ?? {}) as { resources?: { core?: Record<string, unknown> } }).resources?.core ?? {};
  const n = (k: string): number => {
    const v = core[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(`rate_limit: bad ${k}`);
    return v;
  };
  return { limit: n('limit'), remaining: n('remaining'), used: n('used'), reset: n('reset') };
}

/** Calls an event poll leaves for the rest of the hour (agents' safe outputs, the onboard and steward
 *  App jobs, and the scheduled and follow-up polls, which always run). */
export const RATE_RESERVE = 1000;
/** Triggers that always poll, whatever the quota (they're the factory's own cadence). */
const CADENCE_TRIGGERS = new Set(['schedule', 'workflow_dispatch', 'local']);

/** Skip an event-triggered poll when the quota is below the reserve: a poll that starts then fails
 *  partway (HTTP 403) after spending what's left. Pure. */
export function rateReserveSkip(trigger: string, rl: RateLimit, reserve: number = RATE_RESERVE): string | null {
  if (CADENCE_TRIGGERS.has(trigger) || rl.remaining >= reserve) return null;
  return `rate_reserve: ${rl.remaining} of ${rl.limit} API calls left (reserve ${reserve}); this ${trigger} poll is skipped until the quota resets at ${new Date(rl.reset * 1000).toISOString()}`;
}

export async function paginate<T>(
  client: GitHubClient,
  path: string,
  extract: (data: unknown) => T[],
  maxPages = MAX_PAGES,
): Promise<T[]> {
  const out: T[] = [];
  let next: string | null = path;
  for (let page = 0; next; page++) {
    if (page >= maxPages) throw new Error(`pagination exceeded ${maxPages} pages for ${path.split('?')[0]}`);
    const res: ApiResponse = await client.request('GET', next);
    out.push(...extract(res.data));
    next = res.next;
  }
  return out;
}

export async function graphql(client: GitHubClient, query: string, variables: Record<string, unknown>): Promise<unknown> {
  const res = await client.request('POST', '/graphql', { body: { query, variables } });
  const body = res.data as { data?: unknown; errors?: unknown[] } | null;
  if (!body || (body.errors && body.errors.length > 0) || !body.data) throw new Error('GraphQL query failed');
  return body.data;
}

// ---------------------------------------------------------------- parsing helpers

type Rec = Record<string, unknown>;
const asRec = (v: unknown): Rec => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asStr = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const LOGIN = /^[A-Za-z0-9-]{1,39}(\[bot\])?$/;
const HEX40 = /^[0-9a-f]{40}$/;

function login(author: unknown): { login: string | null; bot: boolean } {
  const a = asRec(author);
  let l = asStr(a.login);
  const bot = a.__typename === 'Bot' || a.type === 'Bot' || (l?.endsWith('[bot]') ?? false);
  if (l && bot && !l.endsWith('[bot]')) l = `${l}[bot]`;
  return { login: l && LOGIN.test(l) ? l : null, bot };
}

function requireStr(v: unknown, what: string): string {
  if (typeof v !== 'string' || v === '') throw new Error(`snapshot: missing ${what}`);
  return v;
}

function requireInt(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new Error(`snapshot: missing ${what}`);
  return v;
}

/** The ci `checks` job's auto-strict step (ci.yml): its runner-reported result is the evidence. */
export const FULL_REGRESSION_STEP = 'Full regression (auto-strict) - held-out comparison, 10000 phrases';
/**
 * Strict gates enforced as steps of `ci`'s `checks` job (same `if:` as the full regression, no
 * continue-on-error), so a green `ci` with a successful FULL_REGRESSION_STEP passed them all.
 * The other implemented strict gates are enforced by the controller itself.
 */
export const CI_STRICT_GATE_STEPS: Readonly<Record<string, string>> = {
  full_regression: FULL_REGRESSION_STEP,
  semver_checks: 'Strict gate - semver_checks (no public API break)',
  mutation_score_not_lower: 'Strict gate - mutation_score_not_lower (changed code, cargo-mutants)',
  perf_regression_max_pct: 'Strict gate - perf_regression_max_pct (golden phrases bench, criterion)',
  code_health_not_worse: 'Strict gate - code_health_not_worse (clippy complexity lints)',
};
export const CONTROLLER_STRICT_GATES: readonly string[] = ['reviewer_agent', 'serialize_area', 'auto_revert_on_regression'];

/** Conclusion of the step with exactly this name, or null if it isn't in the job (or appears twice). */
export function stepConclusion(steps: unknown[], name: string): string | null {
  const found = steps.map(asRec).filter((st) => st.name === name);
  return found.length === 1 ? asStr(found[0]!.conclusion) : null;
}

/** The first step of the ci `checks` job: the only trusted source of the held-out seed commitment. */
export const HELDOUT_COMMIT_STEP = 'Held-out seed commitment (trusted, before any PR code)';

const TIMESTAMP_PREFIX = /^\uFEFF?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z /;
const MAX_REVEALS = 20;

/**
 * The held-out seed, by commit–reveal (DESIGN §9, §11). The `checks` job runs PR code, so no
 * log line printed after that code starts can be trusted on its own. The trusted first step
 * prints `factory-heldout-commit: <sha256("<salt>:<seed>")>` before any PR code is on the
 * runner; after the run, `factory-heldout-seed: <n>` and `factory-heldout-salt: <hex>` reveal it.
 * A seed is returned only if:
 *   - exactly one commitment line exists, and it is inside the first step's `##[group]Run`
 *     section (output printed later can't move before it), and no commitment line appears
 *     anywhere else (a second one means something forged it: fail closed);
 *   - exactly one revealed seed matches it with a revealed salt.
 * The seed stays a decimal string.
 */
export function parseHeldoutSeed(text: string): string | null {
  let runGroups = 0;
  const commits: string[] = [];
  let foreignCommit = false;
  const seeds = new Set<string>();
  const salts = new Set<string>();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '').replace(TIMESTAMP_PREFIX, '');
    if (line.startsWith('##[group]Run ')) {
      runGroups++;
      continue;
    }
    let m = /^factory-heldout-commit: ([0-9a-f]{64})$/.exec(line);
    if (m) {
      if (runGroups === 1) commits.push(m[1]!);
      else foreignCommit = true;
      continue;
    }
    m = /^factory-heldout-seed: (0|[1-9][0-9]{0,19})$/.exec(line);
    if (m) seeds.add(m[1]!);
    m = /^factory-heldout-salt: ([0-9a-f]{32})$/.exec(line);
    if (m) salts.add(m[1]!);
  }
  if (foreignCommit || commits.length !== 1) return null;
  const matches = new Set<string>();
  for (const seed of [...seeds].slice(0, MAX_REVEALS)) {
    for (const salt of [...salts].slice(0, MAX_REVEALS)) {
      if (createHash('sha256').update(`${salt}:${seed}`).digest('hex') === commits[0]) matches.add(seed);
    }
  }
  return matches.size === 1 ? [...matches][0]! : null;
}

/** CI job conclusions that mean the job failed. */
const FAILED_JOB_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure']);

/**
 * The failure signature, from runner-reported step results (the jobs API), never from log
 * text that PR code could print: `step:<slug of the first failed step>`, or `job:<conclusion>`
 * when the job failed without a failed step (for example a timeout). Null for a job that didn't fail.
 */
export function failureSignatureFromSteps(steps: unknown[], jobConclusion: string | null): string | null {
  if (!jobConclusion || !FAILED_JOB_CONCLUSIONS.has(jobConclusion)) return null;
  const ordered = steps.map(asRec).filter((st) => typeof st.number === 'number').sort((a, b) => Number(a.number) - Number(b.number));
  const failed = ordered.find((st) => st.conclusion === 'failure');
  if (failed) {
    const slug = (asStr(failed.name) ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
    return `step:${slug || 'unnamed'}`;
  }
  return `job:${jobConclusion}`;
}

/** True if the job's first step after "Set up job" is the trusted commitment step and it succeeded. */
export function trustedCommitStepRan(steps: unknown[]): boolean {
  const ordered = steps.map(asRec).filter((st) => typeof st.number === 'number').sort((a, b) => Number(a.number) - Number(b.number));
  const first = ordered.find((st) => st.name !== 'Set up job');
  return first !== undefined && first.name === HELDOUT_COMMIT_STEP && first.conclusion === 'success';
}

// ---------------------------------------------------------------- snapshot pieces

export async function readIssues(client: GitHubClient, repo: string): Promise<IssueSnap[]> {
  const items = await paginate(client, `/repos/${repo}/issues?state=open&per_page=100`, asArr);
  const out: IssueSnap[] = [];
  for (const it of items) {
    const i = asRec(it);
    if (i.pull_request !== undefined) continue;
    const marker = parseTaskMarker(asStr(i.body));
    out.push({
      number: requireInt(i.number, 'issue number'),
      node_id: requireStr(i.node_id, 'issue node_id'),
      labels: asArr(i.labels).map((l) => asStr(asRec(l).name) ?? '').filter((n) => n !== ''),
      task_id: marker.task_id,
      marker_status: marker.status,
    });
  }
  return out;
}

export const PULLS_QUERY = `query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 50, after: $cursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id number state isDraft createdAt mergedAt body headRefOid headRefName mergeable isInMergeQueue
        mergeCommit { oid }
        author { login __typename }
        labels(first: 100) { pageInfo { hasNextPage } nodes { name } }
        reviews(last: 100) { nodes { id state submittedAt author { login __typename } } }
        timelineItems(last: 100, itemTypes: [ADDED_TO_MERGE_QUEUE_EVENT, REMOVED_FROM_MERGE_QUEUE_EVENT, LABELED_EVENT]) {
          nodes {
            __typename
            ... on AddedToMergeQueueEvent { id createdAt actor { login __typename } }
            ... on RemovedFromMergeQueueEvent { id createdAt reason actor { login __typename } }
            ... on LabeledEvent { createdAt label { name } actor { login __typename } }
          }
        }
      }
    }
  }
}`;

export function mapPull(node: unknown): PullSnap {
  const n = asRec(node);
  const stateMap: Record<string, PullState> = { OPEN: 'open', CLOSED: 'closed', MERGED: 'merged' };
  const state = stateMap[asStr(n.state) ?? ''];
  if (!state) throw new Error('snapshot: unknown PR state');
  const labelsConn = asRec(n.labels);
  if (asRec(labelsConn.pageInfo).hasNextPage === true) throw new Error('snapshot: too many PR labels');
  const trailers = parsePrTrailers(asStr(n.body));
  const author = login(n.author);
  const reviews: ReviewSnap[] = asArr(asRec(n.reviews).nodes).map((r) => {
    const rv = asRec(r);
    const a = login(rv.author);
    return {
      node_id: requireStr(rv.id, 'review id'),
      author: a.login,
      author_is_bot: a.bot,
      state: asStr(rv.state) ?? 'UNKNOWN',
      submitted_at: asStr(rv.submittedAt),
    };
  });
  const mq: MergeQueueEventSnap[] = [];
  const labeled: NonNullable<PullSnap['labeled_events']> = [];
  for (const t of asArr(asRec(n.timelineItems).nodes)) {
    const ev = asRec(t);
    if (ev.__typename === 'LabeledEvent') {
      const name = asStr(asRec(ev.label).name);
      const a = login(ev.actor);
      if (name) labeled.push({ label: name, actor: a.login, actor_is_bot: a.bot, at: asStr(ev.createdAt) ?? '' });
      continue;
    }
    const kind =
      ev.__typename === 'AddedToMergeQueueEvent' ? 'queued' : ev.__typename === 'RemovedFromMergeQueueEvent' ? 'dequeued' : null;
    if (!kind) continue;
    mq.push({
      node_id: requireStr(ev.id, 'merge queue event id'),
      kind,
      created_at: requireStr(ev.createdAt, 'merge queue event time'),
      actor: login(ev.actor).login,
      reason: asStr(ev.reason),
    });
  }
  const headSha = requireStr(n.headRefOid, 'PR head sha');
  const mergeSha = asStr(asRec(n.mergeCommit).oid);
  return {
    number: requireInt(n.number, 'PR number'),
    node_id: requireStr(n.id, 'PR id'),
    state,
    draft: n.isDraft === true,
    author: author.login,
    author_is_bot: author.bot,
    head_sha: headSha,
    created_at: requireStr(n.createdAt, 'PR createdAt'),
    merged_at: asStr(n.mergedAt),
    merge_commit_sha: mergeSha && HEX40.test(mergeSha) ? mergeSha : null,
    labels: asArr(labelsConn.nodes).map((l) => asStr(asRec(l).name) ?? '').filter((x) => x !== ''),
    task_id: trailers.task_id,
    contract_sha: trailers.contract_sha,
    attempt: trailers.attempt,
    reviews,
    merge_queue_events: mq,
    mergeable: asStr(n.mergeable),
    in_merge_queue: n.isInMergeQueue === true,
    head_ref: asStr(n.headRefName),
    labeled_events: labeled,
  };
}

/**
 * All PRs (every state) through GraphQL. Merge-queue facts come from the PR
 * timeline items AddedToMergeQueueEvent / RemovedFromMergeQueueEvent.
 */
export async function readPulls(client: GitHubClient, repo: string): Promise<PullSnap[]> {
  const [owner, name] = repo.split('/');
  const out: PullSnap[] = [];
  let cursor: string | null = null;
  for (let page = 0; ; page++) {
    if (page >= MAX_PAGES) throw new Error('snapshot: too many PR pages');
    const data = asRec(await graphql(client, PULLS_QUERY, { owner, name, cursor }));
    const conn = asRec(asRec(asRec(data.repository).pullRequests));
    for (const node of asArr(conn.nodes)) out.push(mapPull(node));
    const info = asRec(conn.pageInfo);
    if (info.hasNextPage !== true) break;
    cursor = requireStr(info.endCursor, 'PR cursor');
  }
  return out;
}

/** Resolves `main` to one immutable commit SHA for the whole snapshot. */
export async function resolveMainSha(client: GitHubClient, repo: string): Promise<string> {
  const ref = asRec((await client.request('GET', `/repos/${repo}/git/ref/heads/main`)).data);
  const sha = requireStr(asRec(ref.object).sha, 'main commit sha');
  if (!HEX40.test(sha)) throw new Error('snapshot: main does not resolve to a commit SHA');
  return sha;
}

/**
 * Contracts at the commit `mainSha` for the given task ids (plus their
 * dependency closure). The tree, every blob and every `commits?path=…`
 * history lookup use that same commit, so contents and contract commit SHA
 * always come from one consistent state of main.
 */
export async function readContracts(
  client: GitHubClient,
  repo: string,
  mainSha: string,
  tasks: Iterable<string>,
): Promise<Record<string, ContractSnap>> {
  if (!HEX40.test(mainSha)) throw new Error('snapshot: contracts must be read at a full commit SHA');
  const commit = asRec((await client.request('GET', `/repos/${repo}/git/commits/${mainSha}`)).data);
  const treeSha = requireStr(asRec(commit.tree).sha, 'main tree sha');
  const tree = asRec((await client.request('GET', `/repos/${repo}/git/trees/${treeSha}?recursive=1`)).data);
  if (tree.truncated === true) throw new Error('snapshot: git tree truncated');
  const blobs = new Map<string, string>();
  for (const e of asArr(tree.tree)) {
    const entry = asRec(e);
    const path = asStr(entry.path);
    if (entry.type === 'blob' && path && /^contracts\/.+\.yaml$/.test(path)) blobs.set(path, requireStr(entry.sha, 'blob sha'));
  }
  const out: Record<string, ContractSnap> = {};
  const queue = [...tasks].filter(isTaskId);
  const seen = new Set<string>();
  while (queue.length > 0) {
    const task = queue.shift()!;
    if (seen.has(task)) continue;
    seen.add(task);
    const path = contractPath(task);
    const blobSha = blobs.get(path);
    if (!blobSha) continue;
    const blob = asRec((await client.request('GET', `/repos/${repo}/git/blobs/${blobSha}`)).data);
    if (blob.encoding !== 'base64') throw new Error('snapshot: unexpected blob encoding');
    const text = Buffer.from(requireStr(blob.content, 'blob content'), 'base64').toString('utf8');
    const commits = asArr(
      (await client.request('GET', `/repos/${repo}/commits?path=${encodeURIComponent(path)}&sha=${mainSha}&per_page=1`)).data,
    );
    const lastCommit = requireStr(asRec(commits[0]).sha, `last commit for ${path}`);
    const c = parseContract(path, blobSha, lastCommit, text);
    out[path] = c;
    for (const d of c.depends_on) queue.push(d);
  }
  return out;
}

export interface RecordedCheck {
  heldout_seed: string | null;
  /** The seed couldn't be read (never recorded; see CheckRunSnap.heldout_pending). */
  heldout_pending?: boolean;
  failure_signature: string | null;
  full_regression?: string | null;
}

/** Most recent pages of `/actions/runs` scanned per poll (×100 runs). */
export const RECENT_RUN_PAGES = 3;
/** At most this many open PR heads get their own `?head_sha=` lookup per poll. */
export const MAX_HEAD_LOOKUPS = 30;

async function firstPages<T>(client: GitHubClient, path: string, extract: (data: unknown) => T[], pages: number): Promise<T[]> {
  const out: T[] = [];
  let next: string | null = path;
  for (let page = 0; next && page < pages; page++) {
    const res: ApiResponse = await client.request('GET', next);
    out.push(...extract(res.data));
    next = res.next;
  }
  return out;
}

/**
 * Discovers check runs without a creation cutoff (re-runs keep their original
 * `created_at`): the newest RECENT_RUN_PAGES pages of all runs, plus one page
 * of `?head_sha=` for each open PR head (at most MAX_HEAD_LOOKUPS). Calls are
 * bounded by RECENT_RUN_PAGES + MAX_HEAD_LOOKUPS. Runs are kept if they were
 * updated inside the observation window or belong to an open PR head.
 */
/** Open PR heads that readCheckRuns does not look up by `?head_sha=` (sorted). */
export function uncheckedHeads(openHeads: ReadonlySet<string>): string[] {
  return [...openHeads].sort().filter((h, i) => i >= MAX_HEAD_LOOKUPS || !HEX40.test(h));
}

export async function readCheckRuns(
  client: GitHubClient,
  repo: string,
  now: Date,
  windowHours: number,
  recorded: ReadonlyMap<string, RecordedCheck>,
  openHeads: ReadonlySet<string>,
  /** main's commit: CI signals count only if the run's diff from it leaves `.github/` alone (null = none count). */
  mainSha: string | null = null,
): Promise<CheckRunSnap[]> {
  const extract = (d: unknown): unknown[] => asArr(asRec(d).workflow_runs);
  const found = await firstPages(client, `/repos/${repo}/actions/runs?per_page=100`, extract, RECENT_RUN_PAGES);
  for (const head of [...openHeads].sort().slice(0, MAX_HEAD_LOOKUPS)) {
    if (!HEX40.test(head)) continue;
    found.push(...(await firstPages(client, `/repos/${repo}/actions/runs?head_sha=${head}&per_page=100`, extract, 1)));
  }
  // The same run can appear in both lists; keep its newest attempt.
  const byId = new Map<number, Rec>();
  for (const r of found) {
    const run = asRec(r);
    const id = requireInt(run.id, 'run id');
    const prev = byId.get(id);
    const attempt = typeof run.run_attempt === 'number' ? run.run_attempt : 1;
    const prevAttempt = prev && typeof prev.run_attempt === 'number' ? prev.run_attempt : 1;
    if (!prev || attempt > prevAttempt || (attempt === prevAttempt && String(run.updated_at) > String(prev.updated_at))) byId.set(id, run);
  }

  const windowStart = now.getTime() - windowHours * 3_600_000;
  const out: CheckRunSnap[] = [];
  for (const run of [...byId.values()].sort((a, b) => Number(a.id) - Number(b.id))) {
    const name = typeof run.name === 'string' ? run.name : '';
    const events = Object.hasOwn(CHECK_WORKFLOWS, name) ? CHECK_WORKFLOWS[name]! : null;
    const event = run.event;
    if (!events || typeof event !== 'string' || !events.includes(event)) continue;
    const prs = asArr(run.pull_requests).map(asRec);
    const headSha = requireStr(run.head_sha, 'run head sha');
    let candidate: string | null = headSha;
    if (event === 'pull_request_target') {
      const heads = new Set(prs.map((p) => asStr(asRec(p.head).sha)).filter((x): x is string => x !== null && HEX40.test(x)));
      candidate = heads.size === 1 ? [...heads][0]! : null;
    }
    const snap: CheckRunSnap = {
      run_id: requireInt(run.id, 'run id'),
      run_attempt: requireInt(run.run_attempt ?? 1, 'run attempt'),
      workflow: name,
      event: event as CheckEvent,
      head_sha: headSha,
      candidate_sha: candidate,
      pull_requests: prs.map((p) => p.number).filter((n): n is number => typeof n === 'number' && Number.isSafeInteger(n)),
      status: asStr(run.status) ?? 'unknown',
      conclusion: asStr(run.conclusion),
      created_at: requireStr(run.created_at, 'run created_at'),
      updated_at: requireStr(run.updated_at, 'run updated_at'),
      heldout_seed: null,
      failure_signature: null,
    };
    // A re-run of a post-merge check: attempt 1's recorded signature, to confirm a regression.
    if (event === 'push' && snap.run_attempt > 1) snap.first_attempt_signature = recorded.get(`${snap.run_id}/attempts/1`)?.failure_signature ?? null;
    const inWindow = Date.parse(snap.updated_at) >= windowStart;
    const forOpenPr = (candidate !== null && openHeads.has(candidate)) || openHeads.has(headSha);
    if (!inWindow && !forOpenPr) continue;
    if (snap.status === 'completed' && snap.conclusion) {
      const key = `${snap.run_id}/attempts/${snap.run_attempt}`;
      const known = recorded.get(key);
      // A pending record keeps its step-derived signature but its seed is read again.
      if (known && !known.heldout_pending) {
        snap.heldout_seed = known.heldout_seed;
        snap.failure_signature = known.failure_signature;
        snap.full_regression = known.full_regression ?? null;
      } else if (name === CI_WORKFLOW_NAME) {
        // The ci `checks` job: seed from its trusted commit–reveal, signature from its step
        // results, but only if the change under test leaves `.github/` alone. `pull_request`
        // runs execute the PR's (merged) copy of the workflow, so a change there could forge both.
        const dir = mainSha ? await githubDirCheck(client, repo, mainSha, headSha) : 'touched';
        if (dir === 'clean') Object.assign(snap, await readChecksJobLog(client, repo, snap.run_id, snap.run_attempt));
        else if (dir === 'unknown') snap.heldout_pending = true;
      }
    }
    out.push(snap);
  }
  return out;
}

/** GitHub's compare API lists at most this many files; a longer diff can't be checked. */
const COMPARE_FILE_LIMIT = 300;

/**
 * True only if the change from `base` to `head` (three-dot: since their merge base, i.e. the
 * PR's own changes) touches nothing under `.github/`, including either side of a rename. Any
 * error, a truncated file list or a missing commit returns false (fail closed).
 */
export async function leavesGithubDirAlone(client: GitHubClient, repo: string, base: string, head: string): Promise<boolean> {
  return (await githubDirCheck(client, repo, base, head)) === 'clean';
}

/**
 * `leavesGithubDirAlone`, telling a definite answer from none: `touched` (a `.github/` path, a
 * truncated list or malformed SHAs: never trusted), `unknown` (the compare API answered 403/404/422/429,
 * throttled, or a commit not yet visible: ask again next poll), `clean`.
 */
export async function githubDirCheck(client: GitHubClient, repo: string, base: string, head: string): Promise<'clean' | 'touched' | 'unknown'> {
  if (!HEX40.test(base) || !HEX40.test(head)) return 'touched';
  if (base === head) return 'clean';
  // 403/429 (rate limits, incl. secondary) are no answer too, like 404/422: never a verdict.
  const res = await client.request('GET', `/repos/${repo}/compare/${base}...${head}?per_page=${COMPARE_FILE_LIMIT}`, { allowStatuses: [403, 404, 422, 429] });
  if (res.status !== 200) return 'unknown';
  const files = asRec(res.data).files;
  if (!Array.isArray(files) || files.length >= COMPARE_FILE_LIMIT) return 'touched';
  for (const f of files.map(asRec)) {
    for (const path of [f.filename, f.previous_filename]) {
      if (path === undefined) continue;
      if (typeof path !== 'string' || path === '.github' || path.startsWith('.github/')) return 'touched';
    }
  }
  return 'clean';
}

export async function readChecksJobLog(client: GitHubClient, repo: string, runId: number, attempt: number): Promise<RecordedCheck> {
  const jobs = await paginate(client, `/repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`, (d) =>
    asArr(asRec(d).jobs),
  );
  const checks = jobs.map(asRec).filter((j) => j.name === CHECKS_JOB_NAME);
  if (checks.length !== 1) return { heldout_seed: null, failure_signature: null, full_regression: null };
  const job = checks[0]!;
  const steps = asArr(job.steps);
  const failure_signature = failureSignatureFromSteps(steps, asStr(job.conclusion));
  const full_regression = stepConclusion(steps, FULL_REGRESSION_STEP);
  if (!trustedCommitStepRan(steps)) return { heldout_seed: null, failure_signature, full_regression };
  const jobId = requireInt(job.id, 'job id');
  const res = await client.request('GET', `/repos/${repo}/actions/jobs/${jobId}/logs`, {
    accept: 'raw',
    allowStatuses: [403, 404, 410, 429],
  });
  // No log yet (404/410 shortly after a run completes, 403/429 throttled, or an empty body):
  // pending, read again next poll.
  if (typeof res.data !== 'string' || res.data.trim() === '') return { heldout_seed: null, heldout_pending: true, failure_signature, full_regression };
  return { heldout_seed: parseHeldoutSeed(res.data), failure_signature, full_regression };
}

const BUSY_JOB_STATUSES = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested']);

/** Running + queued Actions jobs across every repo of the org the token can see. */
export async function readBusyJobs(client: GitHubClient, org: string): Promise<number> {
  const repos = await paginate(client, `/orgs/${org}/repos?per_page=100&type=all`, asArr);
  let busy = 0;
  for (const r of repos) {
    const repo = asRec(r);
    if (repo.archived === true) continue;
    const full = requireStr(repo.full_name, 'repo full_name');
    for (const status of ['in_progress', 'queued']) {
      const runs = await paginate(client, `/repos/${full}/actions/runs?status=${status}&per_page=100`, (d) =>
        asArr(asRec(d).workflow_runs),
      );
      for (const run of runs) {
        const id = requireInt(asRec(run).id, 'run id');
        const jobs = await paginate(client, `/repos/${full}/actions/runs/${id}/jobs?per_page=100`, (d) => asArr(asRec(d).jobs));
        busy += jobs.filter((j) => BUSY_JOB_STATUSES.has(asStr(asRec(j).status) ?? '')).length;
      }
    }
  }
  return busy;
}

export interface ReadSnapshotOptions {
  repo: string;
  now: Date;
  windowHours: number;
  recordedChecks: ReadonlyMap<string, RecordedCheck>;
  historyTasks: Iterable<string>;
  needBusyJobs: boolean;
  /** The reviewer App's id (REVIEWER_APP_ID); null = no reviewer verdict is accepted. */
  reviewerAppId?: number | null;
  /** Read code scanning on open factory PR heads (limits.ci.wait_for_code_scanning). */
  codeScanning?: boolean;
}

const REVIEWED_HEAD = /^Reviewed-Head: ([0-9a-f]{40})[ \t]*$/;

/**
 * `factory-review` check runs on the given heads (at most MAX_HEAD_LOOKUPS), kept only if the
 * reviewer App created them on that exact head. Anyone with checks:write can name a check run
 * `factory-review`; only the App id makes it the reviewer's.
 */
export async function readReviewChecks(client: GitHubClient, repo: string, heads: Iterable<string>, appId: number): Promise<ReviewCheckSnap[]> {
  const out: ReviewCheckSnap[] = [];
  for (const head of [...new Set(heads)].filter((h) => HEX40.test(h)).sort().slice(0, MAX_HEAD_LOOKUPS)) {
    const runs = await paginate(client, `/repos/${repo}/commits/${head}/check-runs?check_name=${REVIEW_CHECK_NAME}&filter=all&per_page=100`, (d) => asArr(asRec(d).check_runs));
    for (const r of runs) {
      const c = asRec(r);
      if (asRec(c.app).id !== appId || c.name !== REVIEW_CHECK_NAME || c.head_sha !== head) continue;
      const id = c.id;
      const started = asStr(c.started_at);
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || !started) continue;
      const first = (asStr(asRec(c.output).summary) ?? '').split('\n')[0]!.replace(/\r$/, '');
      out.push({ id, head_sha: head, status: asStr(c.status) ?? 'unknown', conclusion: asStr(c.conclusion), started_at: started, reviewed_head: REVIEWED_HEAD.exec(first)?.[1] ?? null });
    }
  }
  return out;
}

/** GitHub Advanced Security, the app that posts the `CodeQL` code-scanning check. */
export const CODE_SCANNING_APP_ID = 57789;
/** GitHub Actions (default setup's Analyze jobs). */
const ACTIONS_APP_ID = 15368;

/** Code scanning on each head: the CodeQL check and the Analyze jobs (at most MAX_HEAD_LOOKUPS heads). */
export async function readCodeScanning(client: GitHubClient, repo: string, heads: Iterable<string>): Promise<CodeScanningSnap[]> {
  const out: CodeScanningSnap[] = [];
  for (const head of [...new Set(heads)].filter((h) => HEX40.test(h)).sort().slice(0, MAX_HEAD_LOOKUPS)) {
    const runs = (await paginate(client, `/repos/${repo}/commits/${head}/check-runs?filter=latest&per_page=100`, (d) => asArr(asRec(d).check_runs))).map(asRec);
    const codeql = runs
      .filter((c) => c.name === 'CodeQL' && asRec(c.app).id === CODE_SCANNING_APP_ID && c.head_sha === head)
      .sort((a, b) => (Number(b.id) || 0) - (Number(a.id) || 0))[0];
    const analyze = runs
      .filter((c) => typeof c.name === 'string' && c.name.startsWith('Analyze (') && asRec(c.app).id === ACTIONS_APP_ID && c.head_sha === head)
      .map((c) => {
        const m = /\/actions\/runs\/([0-9]{1,20})(?:\/attempts\/([0-9]{1,3}))?\/job\//.exec(asStr(c.details_url) ?? '');
        return { name: c.name as string, status: asStr(c.status) ?? 'unknown', conclusion: asStr(c.conclusion), run_id: m ? Number(m[1]) : null, run_attempt: m?.[2] ? Number(m[2]) : null };
      });
    // A job URL doesn't name the attempt: read it from the run, only for failed jobs (the re-run rule).
    // If the run isn't completed, a re-run started after the check runs were read: the failure we saw
    // belongs to an earlier attempt, so the job counts as still running (wait for the retry).
    const runInfo = new Map<number, { attempt: number | null; done: boolean }>();
    for (const a of analyze) {
      if (a.run_id === null || a.run_attempt !== null || a.conclusion === null || a.conclusion === 'success') continue;
      if (!runInfo.has(a.run_id)) {
        const run = asRec((await client.request('GET', `/repos/${repo}/actions/runs/${a.run_id}`)).data);
        runInfo.set(a.run_id, { attempt: typeof run.run_attempt === 'number' ? run.run_attempt : null, done: run.status === 'completed' });
      }
      const r = runInfo.get(a.run_id)!;
      if (!r.done) {
        a.status = 'in_progress';
        a.conclusion = null;
      } else a.run_attempt = r.attempt;
    }
    out.push({ head_sha: head, codeql: codeql ? { status: asStr(codeql.status) ?? 'unknown', conclusion: asStr(codeql.conclusion) } : null, analyze });
  }
  return out;
}

/** When an issue was last reopened (ISO), from its events; null if never, or if the events can't be read. */
export async function readReopenedAt(client: GitHubClient, repo: string, issue: number): Promise<string | null> {
  try {
    const events = await paginate(client, `/repos/${repo}/issues/${issue}/events?per_page=100`, asArr, 5);
    let last: string | null = null;
    for (const e of events) {
      const x = asRec(e);
      const at = asStr(x.created_at);
      if (x.event === 'reopened' && at && (!last || at > last)) last = at;
    }
    return last;
  } catch {
    return null;
  }
}

export const INFRA_INCIDENT_LABEL = 'factory:infra-incident';
// `Infra incident: <ref> <prose>`: the ref (the fixing PR or incident issue: #303, owner/repo#12, or
// a github.com URL) is what the audit log keeps (IDs only); the comment URL points at the prose.
const INFRA_INCIDENT_REASON_RE = /^Infra incident:[ \t]*(#\d{1,9}|[A-Za-z0-9._-]{1,39}\/[A-Za-z0-9._-]{1,100}#\d{1,9}|https:\/\/github\.com\/[A-Za-z0-9._/-]{1,170}(?:#[A-Za-z0-9_-]{1,20})?)(?=\s|$)/i;

/**
 * The infra-incident record of an issue carrying INFRA_INCIDENT_LABEL: the latest time a user (not a
 * bot or App) added the label, and that user's latest `Infra incident: <ref> <reason>` comment. null if
 * either is missing or the events can't be read: no record, so nothing is excluded (fail closed).
 */
export async function readInfraIncident(client: GitHubClient, repo: string, issue: number): Promise<InfraIncidentSnap | null> {
  try {
    const events = await paginate(client, `/repos/${repo}/issues/${issue}/events?per_page=100`, asArr, 5);
    let last: { actor: string; at: string } | null = null;
    for (const e of events) {
      const x = asRec(e);
      const actor = asRec(x.actor);
      const login = asStr(actor.login);
      const at = asStr(x.created_at);
      if (x.event !== 'labeled' || asStr(asRec(x.label).name) !== INFRA_INCIDENT_LABEL || !login || !at) continue;
      if (actor.type !== 'User' || login.endsWith('[bot]')) continue;
      if (!last || at > last.at) last = { actor: login, at };
    }
    if (!last) return null;
    const comments = await paginate(client, `/repos/${repo}/issues/${issue}/comments?per_page=100`, asArr, 5);
    let reason: { text: string; url: string; at: string } | null = null;
    for (const c of comments) {
      const x = asRec(c);
      const at = asStr(x.created_at);
      const url = asStr(x.html_url);
      const m = INFRA_INCIDENT_REASON_RE.exec((asStr(x.body) ?? '').trim());
      if (!m || !at || !url || asStr(asRec(x.user).login) !== last.actor) continue;
      if (!reason || at > reason.at) reason = { text: m[1]!, url, at };
    }
    return reason ? { actor: last.actor, labeled_at: last.at, incident: reason.text, comment_url: reason.url } : null;
  } catch {
    return null;
  }
}

/**
 * Task issues labelled INFRA_INCIDENT_LABEL in any state, each with its record. A failed listing is
 * none (nothing is excused: the first-try rate then counts every attempt, stricter, never looser).
 */
export async function readInfraIncidents(client: GitHubClient, repo: string): Promise<InfraIncidentIssueSnap[]> {
  let items: unknown[];
  try {
    items = await paginate(client, `/repos/${repo}/issues?labels=${encodeURIComponent(INFRA_INCIDENT_LABEL)}&state=all&per_page=100`, asArr, 5);
  } catch {
    return [];
  }
  const out: InfraIncidentIssueSnap[] = [];
  for (const it of items) {
    const i = asRec(it);
    if (i.pull_request !== undefined) continue;
    const task_id = parseTaskMarker(asStr(i.body)).task_id;
    const number = i.number;
    const node_id = asStr(i.node_id);
    if (!task_id || typeof number !== 'number' || !Number.isSafeInteger(number) || !node_id) continue;
    out.push({ number, node_id, task_id, record: await readInfraIncident(client, repo, number) });
  }
  return out;
}

/** A workflow's runs created in the last two days; null if they can't be listed (unknown). */
export async function readWorkflowRuns(client: GitHubClient, repo: string, workflowFile: string, now: Date): Promise<RepairRunSnap[] | null> {
  const since = new Date(now.getTime() - 2 * 24 * 3600_000).toISOString().slice(0, 10);
  try {
    const runs = await paginate(client, `/repos/${repo}/actions/workflows/${workflowFile}/runs?created=${encodeURIComponent(`>=${since}`)}&per_page=100`, (d) => asArr(asRec(d).workflow_runs));
    const out: RepairRunSnap[] = [];
    for (const r of runs) {
      const x = asRec(r);
      const id = x.id;
      const title = asStr(x.display_title);
      const created = asStr(x.created_at);
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || !title || !created) continue;
      out.push({ id, display_title: title, created_at: created, status: asStr(x.status) ?? 'unknown', conclusion: asStr(x.conclusion) });
    }
    return out;
  } catch {
    return null;
  }
}

/** The repair workflow's runs created in the last two days; null if they can't be listed (unknown). */
export function readRepairRuns(client: GitHubClient, repo: string, now: Date): Promise<RepairRunSnap[] | null> {
  return readWorkflowRuns(client, repo, REPAIR_WORKFLOW, now);
}

/** Reads everything the planner and observer need. History/spend are filled in by main. */
export async function readSnapshot(client: GitHubClient, o: ReadSnapshotOptions): Promise<Snapshot> {
  // Repair runs before PR heads: a repair that pushes and finishes in between is then seen with its
  // new head (or as still running), never as a finished repair next to the old head (repair_no_push).
  const repair_runs = await readRepairRuns(client, o.repo, o.now);
  // Implement runs too, before the PRs, for the same reason: a run that finished with a PR shows it.
  const implement_runs = await readWorkflowRuns(client, o.repo, IMPLEMENT_WORKFLOW, o.now);
  const issues = await readIssues(client, o.repo);
  // Reopen times only where they matter: open task issues whose task has history (a recorded pick).
  const withHistory = new Set(o.historyTasks);
  for (const i of issues) if (i.task_id && withHistory.has(i.task_id)) i.reopened_at = await readReopenedAt(client, o.repo, i.number);
  // Infra-incident records: task issues carrying the label, open or closed (the tasks are usually
  // merged and closed by the time a person records one), read apart from the planner's open issues.
  const infra_incidents = await readInfraIncidents(client, o.repo);
  const pulls = await readPulls(client, o.repo);
  // Changed files, only for open bug-intake fix PRs (the planner's additive-only check).
  for (const p of pulls) if (p.state === 'open' && intakeFixOf(p) !== null) p.files = await readPullFiles(client, o.repo, p.number);
  // ... and for open generated onboarding PRs (larger: one contract and golden file per step).
  for (const p of pulls) if (p.state === 'open' && onboardingOf(p) !== null) p.files = await readPullFiles(client, o.repo, p.number, 100);
  const tasks = new Set<string>(o.historyTasks);
  for (const i of issues) if (i.task_id) tasks.add(i.task_id);
  for (const p of pulls) if (p.task_id && p.state === 'open') tasks.add(p.task_id);
  const main_sha = await resolveMainSha(client, o.repo);
  const contracts = await readContracts(client, o.repo, main_sha, tasks);
  const openHeads = new Set(pulls.filter((p) => p.state === 'open').map((p) => p.head_sha));
  const check_runs = await readCheckRuns(client, o.repo, o.now, o.windowHours, o.recordedChecks, openHeads, main_sha);
  let busy_jobs: number | null = null;
  if (o.needBusyJobs) {
    try {
      busy_jobs = await readBusyJobs(client, o.repo.split('/')[0]!);
    } catch {
      busy_jobs = null; // unknown → planner waits (busy_jobs_unknown)
    }
  }
  return {
    repo: o.repo,
    fetched_at: isoSeconds(o.now),
    issues,
    infra_incidents,
    pulls,
    main_sha,
    contracts,
    check_runs,
    unchecked_heads: uncheckedHeads(openHeads),
    busy_jobs,
    factory_aic_today: null,
    history: {},
    review_checks:
      typeof o.reviewerAppId === 'number'
        ? await readReviewChecks(client, o.repo, pulls.filter((p) => p.state === 'open' && p.task_id).map((p) => p.head_sha), o.reviewerAppId)
        : [],
    repair_runs,
    implement_runs,
    ...(o.codeScanning ? { code_scanning: await readCodeScanning(client, o.repo, pulls.filter((p) => p.state === 'open' && p.task_id).map((p) => p.head_sha)) } : {}),
  };
}
