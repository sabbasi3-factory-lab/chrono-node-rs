// Thin GitHub REST/GraphQL client (built-in fetch) and the snapshot reader.
// The client refuses every mutating request except the Git Data API writes
// to the audit branch: controller v1 is dry-run only.

import { AUDIT_BRANCH, isoSeconds } from './audit.ts';
import { isTaskId, parseContract, parsePrTrailers, parseTaskMarker, contractPath } from './tasks.ts';
import type {
  ApiResponse,
  CheckEvent,
  CheckRunSnap,
  ContractSnap,
  GitHubClient,
  HttpMethod,
  IssueSnap,
  MergeQueueEventSnap,
  PullSnap,
  PullState,
  RequestOptions,
  ReviewSnap,
  Snapshot,
} from './types.ts';

export const API_BASE = 'https://api.github.com';
export const MAX_PAGES = 40;
export const CI_WORKFLOW_NAME = 'ci';
export const GATES_WORKFLOW_NAME = 'gates';
/** Gate workflows recorded as check_result, and the events each one runs on. */
const CHECK_WORKFLOWS: Record<string, readonly string[]> = {
  [CI_WORKFLOW_NAME]: ['pull_request', 'merge_group'],
  [GATES_WORKFLOW_NAME]: ['pull_request_target', 'merge_group'],
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
 * Throws unless the request is read-only or one of the audit-branch Git Data
 * writes (blob, tree, commit, fast-forward ref update/creation of `audit`).
 */
export function assertAllowedRequest(repo: string, method: HttpMethod, path: string, body?: unknown): void {
  const p = path.split('?')[0] ?? '';
  if (method === 'GET') return;
  const b = (body ?? {}) as Record<string, unknown>;
  if (method === 'POST' && p === '/graphql') {
    const q = b.query;
    if (typeof q === 'string' && /^\s*(query\b|\{)/.test(q) && !/\bmutation\b/i.test(q)) return;
    throw new Error('refusing GraphQL request that is not a read-only query');
  }
  const git = `/repos/${repo}/git`;
  if (method === 'POST' && (p === `${git}/blobs` || p === `${git}/trees` || p === `${git}/commits`)) return;
  if (method === 'PATCH' && p === `${git}/refs/heads/${AUDIT_BRANCH}` && b.force === false) return;
  if (method === 'POST' && p === `${git}/refs` && b.ref === `refs/heads/${AUDIT_BRANCH}`) return;
  throw new Error(`refusing ${method} ${p}: controller v1 is dry-run and only writes the audit branch`);
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

export function createClient(token: string, repo: string, fetchFn: FetchFn = fetch): GitHubClient {
  if (!token) throw new Error('GitHub token missing');
  return {
    async request(method: HttpMethod, path: string, options: RequestOptions = {}): Promise<ApiResponse> {
      if (!path.startsWith('/')) throw new Error('request path must start with /');
      assertAllowedRequest(repo, method, path, options.body);
      const raw = options.accept === 'raw';
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
      const res = await fetchFn(`${API_BASE}${path}`, init);
      if (options.allowStatuses?.includes(res.status)) {
        await res.body?.cancel();
        return { status: res.status, data: null, next: null };
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new GitHubApiError(res.status, `${method} ${path.split('?')[0]}: HTTP ${res.status}`);
      }
      let data: unknown = null;
      if (raw) data = await res.text();
      else if (res.status !== 204) data = await res.json();
      return { status: res.status, data, next: nextPathFromLink(res.headers.get('link')) };
    },
  };
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

/**
 * Extracts the held-out seed and failure signature from a `checks` job log.
 * Lines must be exactly `factory-heldout-seed: <decimal>` /
 * `factory-failure-signature: <token>` (after the Actions timestamp prefix).
 * Seed lines printed by a step whose `##[group]Run …` command passes `--seed`
 * are ignored: that is the reproducible contract-seeded comparison, not the
 * held-out one. Conflicting values yield null (fail closed). The seed stays a
 * decimal string because it may exceed 2^53.
 */
export function parseCheckLog(text: string): { heldout_seed: string | null; failure_signature: string | null } {
  const seeds = new Set<string>();
  const sigs = new Set<string>();
  let seededStep = false;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '').replace(/^\uFEFF?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z /, '');
    if (line.startsWith('##[group]Run ')) {
      seededStep = /(^|\s)--seed(\s|=|$)/.test(line.slice('##[group]Run '.length));
      continue;
    }
    let m = /^factory-heldout-seed: (0|[1-9][0-9]{0,19})$/.exec(line);
    if (m && !seededStep) seeds.add(m[1]!);
    m = /^factory-failure-signature: ([A-Za-z0-9:/#._-]{1,128})$/.exec(line);
    if (m) sigs.add(m[1]!);
  }
  return {
    heldout_seed: seeds.size === 1 ? [...seeds][0]! : null,
    failure_signature: sigs.size === 1 ? [...sigs][0]! : null,
  };
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
        id number state isDraft createdAt mergedAt body headRefOid
        mergeCommit { oid }
        author { login __typename }
        labels(first: 100) { pageInfo { hasNextPage } nodes { name } }
        reviews(last: 100) { nodes { id state submittedAt author { login __typename } } }
        timelineItems(last: 100, itemTypes: [ADDED_TO_MERGE_QUEUE_EVENT, REMOVED_FROM_MERGE_QUEUE_EVENT]) {
          nodes {
            __typename
            ... on AddedToMergeQueueEvent { id createdAt actor { login __typename } }
            ... on RemovedFromMergeQueueEvent { id createdAt actor { login __typename } }
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
  for (const t of asArr(asRec(n.timelineItems).nodes)) {
    const ev = asRec(t);
    const kind =
      ev.__typename === 'AddedToMergeQueueEvent' ? 'queued' : ev.__typename === 'RemovedFromMergeQueueEvent' ? 'dequeued' : null;
    if (!kind) continue;
    mq.push({
      node_id: requireStr(ev.id, 'merge queue event id'),
      kind,
      created_at: requireStr(ev.createdAt, 'merge queue event time'),
      actor: login(ev.actor).login,
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
  failure_signature: string | null;
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
export async function readCheckRuns(
  client: GitHubClient,
  repo: string,
  now: Date,
  windowHours: number,
  recorded: ReadonlyMap<string, RecordedCheck>,
  openHeads: ReadonlySet<string>,
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
    const inWindow = Date.parse(snap.updated_at) >= windowStart;
    const forOpenPr = (candidate !== null && openHeads.has(candidate)) || openHeads.has(headSha);
    if (!inWindow && !forOpenPr) continue;
    if (snap.status === 'completed' && snap.conclusion) {
      const key = `${snap.run_id}/attempts/${snap.run_attempt}`;
      const known = recorded.get(key);
      if (known) {
        snap.heldout_seed = known.heldout_seed;
        snap.failure_signature = known.failure_signature;
      } else if (name === CI_WORKFLOW_NAME) {
        // Only the ci `checks` job prints the held-out seed and failure signature.
        Object.assign(snap, await readChecksJobLog(client, repo, snap.run_id, snap.run_attempt));
      }
    }
    out.push(snap);
  }
  return out;
}

export async function readChecksJobLog(client: GitHubClient, repo: string, runId: number, attempt: number): Promise<RecordedCheck> {
  const jobs = await paginate(client, `/repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`, (d) =>
    asArr(asRec(d).jobs),
  );
  const checks = jobs.map(asRec).filter((j) => j.name === CHECKS_JOB_NAME);
  if (checks.length !== 1) return { heldout_seed: null, failure_signature: null };
  const jobId = requireInt(checks[0]!.id, 'job id');
  const res = await client.request('GET', `/repos/${repo}/actions/jobs/${jobId}/logs`, {
    accept: 'raw',
    allowStatuses: [404, 410],
  });
  if (typeof res.data !== 'string') return { heldout_seed: null, failure_signature: null };
  return parseCheckLog(res.data);
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
}

/** Reads everything the planner and observer need. History/spend are filled in by main. */
export async function readSnapshot(client: GitHubClient, o: ReadSnapshotOptions): Promise<Snapshot> {
  const issues = await readIssues(client, o.repo);
  const pulls = await readPulls(client, o.repo);
  const tasks = new Set<string>(o.historyTasks);
  for (const i of issues) if (i.task_id) tasks.add(i.task_id);
  for (const p of pulls) if (p.task_id && p.state === 'open') tasks.add(p.task_id);
  const main_sha = await resolveMainSha(client, o.repo);
  const contracts = await readContracts(client, o.repo, main_sha, tasks);
  const openHeads = new Set(pulls.filter((p) => p.state === 'open').map((p) => p.head_sha));
  const check_runs = await readCheckRuns(client, o.repo, o.now, o.windowHours, o.recordedChecks, openHeads);
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
    pulls,
    main_sha,
    contracts,
    check_runs,
    busy_jobs,
    factory_aic_today: null,
    history: {},
  };
}
