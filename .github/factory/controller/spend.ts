// Spend collector (DESIGN §11, policies/budgets.yaml). Before planning, every controller run
// measures today's (UTC) factory spend from the implement workflow's own accounting, and
// records it as a `spend_snapshot`. Plain code, no AI, read-only API calls.
//
// Per run of the AI workflows (implement, repair, and the reviewer agent's review) created today (UTC):
//   - queued / in progress  → reserved at the per-run caps (implement + threat detection),
//                             unless every job has finished (see below)
//   - completed             → measured from gh-aw's `usage` artifact, for every job whose
//                             `Execute …` step ran (made model calls):
//       agent:       `agent_usage.json` → `ai_credits`
//       any other:   sum of `ai_credits_this_response` in `<job>/token_usage.jsonl`
//                    (detection today; evals or others if gh-aw adds them)
//     A job whose `Execute …` step was skipped (for example, the dispatch validation failed)
//     made no model calls: 0, provably. A run where none ran needs no artifact.
// A run GitHub still reports as queued/in progress, but whose jobs have all completed including
// the final `conclusion` job (it needs every other job, so nothing can start after it), is
// treated as completed and measured: the run-level status sometimes lags for a long time. If its
// jobs can't be listed, it stays reserved.
// The spend BOUND (only with `bounding`: budgets.yaml per_run.overshoot_margin and its assumptions,
// and compiled workflow caps that match the policy; null → the strict rules below):
//   bound = max-ai-credits + threat_detection + 2 × overshoot_margin   (agent job + detection job)
// max-ai-credits is "stop after the response that crosses the cap", not a strict hard stop: the
// firewall checks the total recorded BEFORE each request (github/gh-aw-firewall v0.28.57,
// containers/api-proxy/guards/ai-credits-guard.js L497-516, `roundedTotalAiCredits >= config.max`),
// so the request admitted just under the cap is billed in full, and parallel requests can each
// overshoot. overshoot_margin = assumed max response × assumed max concurrency.
// With a bound:
//   - a re-run (attempt n > 1) counts n × bound (status `bounded`, reason `rerun`);
//   - a run GitHub reports `completed` whose usage is MISSING (no `usage` artifact, an expired one,
//     or a job that made model calls without its usage file) counts at its bound (status
//     `bounded`, with the reason; main warns and the spend_snapshot audit event lists it). Its
//     agent usage, if the `agent` artifact still has it, is logged as `observed_aic` (never used
//     for accounting: that artifact is produced inside the agent job).
//   - every readable run is checked against the assumptions: max concurrency of its model requests
//     (from the per-response records), its largest single response, and its total against its
//     bound. Any excess turns bounding OFF for the whole read (bounded runs become unknown) and
//     returns an `alert` (main records it and raises factory:alert) so a person reviews the margin.
// This revises #78's "unknown fails closed" for completed runs only: one failed token step (drill
// D1) made a run's usage unreadable and blocked all dispatch for two days.
// Without a bound, a re-run or missing usage is UNKNOWN. Anything else that can't be read is
// always UNKNOWN and the planner dispatches nothing (fail closed): a malformed or corrupt artifact,
// duplicate usage artifacts, a run not reported completed, an implausible attempt number, an API
// error, a run list that can't be read. No runs → 0.
// A run counts toward TODAY's total if it was created today, or if it's a re-run (attempt > 1)
// started today (a re-run keeps its original created_at).

import { crc32, inflateRawSync } from 'node:zlib';
import { paginate } from './github.ts';
import type { GitHubClient, JsonObject } from './types.ts';

export const IMPLEMENT_WORKFLOW_FILE = 'implement.lock.yml';
export const REPAIR_WORKFLOW_FILE = 'repair.lock.yml';
export const REVIEW_WORKFLOW_FILE = 'review.lock.yml';
export const USAGE_ARTIFACT = 'usage';
/** The implement workflow's last job: it needs every other job. */
export const FINAL_JOB = 'conclusion';
export const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
const MAX_ENTRIES = 1000;
/** GitHub allows at most 50 attempts per run; beyond 10 here is implausible for these workflows. */
const MAX_ATTEMPTS = 10;
const JOB_NAME = /^[a-z][a-z0-9_]{0,39}$/;

export interface RunSpend {
  run_id: number;
  status: 'reserved' | 'measured' | 'no_inference' | 'bounded';
  aic: number;
  /** Why the run counts at its bound (status `bounded` only): an enum, as the audit log requires. */
  reason?: UsageMissingCode | 'rerun';
  /** Measured runs: the most model requests in flight at once, and the largest single response. */
  max_concurrency?: number;
  max_response_aic?: number;
  /** Sum of the readable per-response records (the assumption guard; never accounting). */
  responses_aic?: number;
  /** Bounded runs: the agent's usage from the `agent` artifact, if readable (informational only). */
  observed_aic?: number;
}

/** A spend bound in force (see the header). */
export interface Bounding {
  margin: number;
  max_response_aic: number;
  max_concurrency: number;
}

/** A readable run broke an overshoot assumption: bounding is off and a person must review the margin. */
export interface BoundAlert {
  /** exceeded: a run broke an assumption; unverifiable: a readable run's per-response records can't be checked. */
  code: 'overshoot_assumption_exceeded' | 'overshoot_unverifiable';
  run_id: number;
  max_concurrency: number;
  max_response_aic: number;
  aic: number;
  bound: number;
}

export type UsageMissingCode = 'no_usage_artifact' | 'usage_artifact_expired' | 'usage_file_missing';

/** The run's usage is missing (not malformed): a completed run counts at its bound instead. */
export class UsageMissing extends Error {
  readonly code: UsageMissingCode;
  constructor(code: UsageMissingCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Per-task AIC (today and yesterday): by task id, plus runs that name no task (count against every task). */
export interface TaskSpend {
  by_task: Record<string, number>;
  unattributed: number;
  /** Tasks with an unreadable run from yesterday, attributed through the controller's audit dispatch record. */
  unknown_tasks: string[];
}

/** A dispatch the controller recorded in the audit log (non-dry-run `dispatched` / `repair_dispatched`). */
export interface DispatchRecord {
  kind: 'implement' | 'repair';
  task: string;
  issue: number;
  attempt: number;
  /** The audit event's timestamp (recorded just before the dispatch). */
  at: string;
}

/** How long after the dispatch record a run may be created and still be that dispatch's run. */
export const DISPATCH_MATCH_MINUTES = 30;

/**
 * The task of a run, but only if the controller's audit log recorded a dispatch of exactly that
 * kind, task, issue and attempt shortly before the run was created. The run name alone is only
 * the lookup key: anyone who can dispatch can name a run.
 */
export function attributedTask(run: Rec, dispatches: readonly DispatchRecord[]): string | null {
  const title = typeof run.display_title === 'string' ? run.display_title : '';
  const m = /^(Implement|Repair) ([a-z0-9-]+(?:\/[a-z0-9-]+)+) #([1-9][0-9]{0,8}) attempt ([1-9][0-9]?)$/.exec(title);
  const created = typeof run.created_at === 'string' ? Date.parse(run.created_at) : NaN;
  if (!m || !Number.isFinite(created)) return null;
  const kind = m[1] === 'Implement' ? 'implement' : 'repair';
  const hit = dispatches.some((d) => {
    const at = Date.parse(d.at);
    return d.kind === kind && d.task === m[2] && d.issue === Number(m[3]) && d.attempt === Number(m[4]) && at <= created && created - at <= DISPATCH_MATCH_MINUTES * 60_000;
  });
  return hit ? m[2]! : null;
}

export interface SpendOptions {
  /** The spend bound in force (budgets.yaml overshoot margin), or null/absent for none. */
  bounding?: Bounding | null;
  /** Verifies a run's own commit's workflow caps; the bound applies only to verified runs. */
  verifyLock?: LockVerifier | null;
  /** The controller's recorded dispatches (per-task attribution of unreadable runs). */
  dispatches?: readonly DispatchRecord[];
}

export type SpendResult =
  | { aic: number; runs: RunSpend[]; tasks: TaskSpend | null; alert: BoundAlert | null }
  | { aic: null; runs: RunSpend[]; reason: string; tasks: null; alert: BoundAlert | null };

export interface SpendCaps {
  /** budgets.yaml per_run.implement */
  implement: number;
  /** budgets.yaml per_run.repair */
  repair: number;
  /** budgets.yaml per_run.reviewer_agent */
  reviewer_agent: number;
  /** budgets.yaml per_run.threat_detection */
  threat_detection: number;
}

// ---------------------------------------------------------------- zip (read-only, minimal)

const u16 = (b: Uint8Array, o: number): number => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number): number => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

/**
 * Extracts `wanted` files from a ZIP archive. Only stored and deflated entries; no ZIP64, no
 * encryption; every extracted file's size and CRC-32 are checked. Throws on anything else.
 */
export function readZip(buf: Uint8Array, wanted: readonly string[], maxBytes = MAX_ARTIFACT_BYTES): Map<string, string> {
  if (buf.length > maxBytes) throw new Error('artifact too large');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (u32(buf, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip archive');
  const entries = u16(buf, eocd + 10);
  const cdSize = u32(buf, eocd + 12);
  const cdOffset = u32(buf, eocd + 16);
  if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error('zip64 is not supported');
  if (entries > MAX_ENTRIES || cdOffset + cdSize > buf.length) throw new Error('bad zip directory');
  const out = new Map<string, string>();
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  let p = cdOffset;
  let total = 0;
  for (let n = 0; n < entries; n++) {
    if (p + 46 > buf.length || u32(buf, p) !== 0x02014b50) throw new Error('bad zip directory entry');
    const flags = u16(buf, p + 8);
    const method = u16(buf, p + 10);
    const crc = u32(buf, p + 16);
    const compSize = u32(buf, p + 20);
    const size = u32(buf, p + 24);
    const nameLen = u16(buf, p + 28);
    const extraLen = u16(buf, p + 30);
    const commentLen = u16(buf, p + 32);
    const local = u32(buf, p + 42);
    const name = utf8.decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!wanted.includes(name)) continue;
    if (flags & 1) throw new Error('encrypted zip entry');
    if (out.has(name)) throw new Error(`duplicate zip entry ${name}`);
    total += size;
    if (size > maxBytes || total > maxBytes) throw new Error('artifact too large');
    if (local + 30 > buf.length || u32(buf, local) !== 0x04034b50) throw new Error('bad zip local header');
    const start = local + 30 + u16(buf, local + 26) + u16(buf, local + 28);
    if (start + compSize > buf.length) throw new Error('truncated zip entry');
    const raw = buf.subarray(start, start + compSize);
    let data: Uint8Array;
    if (method === 0) data = raw;
    else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: Math.max(1, size) });
    else throw new Error(`unsupported zip method ${method}`);
    if (data.length !== size || crc32(data) !== crc) throw new Error(`zip entry ${name} failed its size/CRC check`);
    out.set(name, utf8.decode(data));
  }
  return out;
}

// ---------------------------------------------------------------- accounting

const isAIC = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** The usage-artifact file that accounts for a job's model calls. */
export const usageFileFor = (job: string): string => (job === 'agent' ? 'agent_usage.json' : `${job}/token_usage.jsonl`);

/** AIC of one completed run from its usage files; throws if any job that made model calls isn't accounted for. */
export function runAIC(files: Map<string, string>, inferredJobs: readonly string[]): number {
  let aic = 0;
  let missing: string | null = null;
  // Every present file is validated first: malformed accounting is unknown (blocks) whatever the
  // job order, and only then is a missing file reported as missing.
  for (const job of inferredJobs) {
    const file = usageFileFor(job);
    const text = files.get(file);
    if (text === undefined) {
      missing ??= `${job} made model calls but ${file} is missing`;
      continue;
    }
    if (job === 'agent') {
      const credits = (JSON.parse(text) as { ai_credits?: unknown } | null)?.ai_credits;
      if (!isAIC(credits)) throw new Error('agent_usage.json has no valid ai_credits');
      aic += credits;
      continue;
    }
    let records = 0;
    let sum = 0;
    let reportedTotal = 0;
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      const rec = JSON.parse(line) as { ai_credits_this_response?: unknown; ai_credits_total?: unknown } | null;
      const credits = rec?.ai_credits_this_response;
      if (!isAIC(credits)) throw new Error(`${file} has a record without a valid ai_credits_this_response`);
      sum += credits;
      if (rec?.ai_credits_total !== undefined) {
        if (!isAIC(rec.ai_credits_total)) throw new Error(`${file} has an invalid ai_credits_total`);
        reportedTotal = Math.max(reportedTotal, rec.ai_credits_total);
      }
      records++;
    }
    if (records === 0) throw new Error(`${job} made model calls but recorded no usage`);
    // A cumulative total above the sum of the responses means records are missing: unknown,
    // never a smaller known number (gh-aw keeps the reported total in that case).
    if (reportedTotal > sum + Math.max(0.001, sum * 1e-6)) throw new Error(`${file} reports ${reportedTotal} AIC in total but its responses add up to ${sum}: records are missing`);
    aic += sum;
  }
  if (missing !== null) throw new UsageMissing('usage_file_missing', missing);
  return aic;
}

/**
 * Max concurrency and largest single response over every `<job>/token_usage.jsonl` present
 * (records carry the response end `timestamp` and `duration_ms`). Null when there are no records
 * or one can't be read: the assumptions are then simply not checked against this run.
 */
export function responseStats(
  files: Map<string, string>,
  requiredJobs: readonly string[] = [],
): { max_concurrency: number; max_response_aic: number; responses_aic: number } | null {
  const edges: [number, number][] = [];
  let maxResponse = 0;
  let total = 0;
  let records = 0;
  const perFile = new Map<string, number>();
  try {
    for (const [name, text] of files) {
      if (!name.endsWith('/token_usage.jsonl')) continue;
      perFile.set(name, 0);
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue;
        const r = JSON.parse(line) as { timestamp?: unknown; duration_ms?: unknown; ai_credits_this_response?: unknown };
        const end = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN;
        const ms = r.duration_ms;
        if (!Number.isFinite(end) || typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0 || !isAIC(r.ai_credits_this_response)) return null;
        edges.push([end - ms, 1], [end, -1]);
        maxResponse = Math.max(maxResponse, r.ai_credits_this_response);
        total += r.ai_credits_this_response;
        perFile.set(name, perFile.get(name)! + 1);
        records++;
      }
    }
  } catch {
    return null;
  }
  if (records === 0) return null;
  // Every job that called the model must have left records of its own (an empty file proves nothing).
  if (requiredJobs.some((j) => (perFile.get(`${j}/token_usage.jsonl`) ?? 0) === 0)) return null;
  // Ends before starts at the same instant: back-to-back requests aren't concurrent.
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let open = 0;
  let max = 0;
  for (const [, d] of edges) {
    open += d;
    max = Math.max(max, open);
  }
  return { max_concurrency: max, max_response_aic: round(maxResponse), responses_aic: round(total) };
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});

/** Whether a job made model calls: its `Execute …` step ran (wasn't skipped). */
export function jobInferred(job: unknown): boolean {
  const steps = Array.isArray(rec(job).steps) ? (rec(job).steps as unknown[]) : [];
  return steps.some((s) => /^Execute /.test(String(rec(s).name ?? '')) && rec(s).conclusion !== 'skipped');
}

/** Every job completed, and the final job (which needs all the others) is among them. */
export function allJobsFinished(jobs: readonly unknown[]): boolean {
  return jobs.length > 0 && jobs.every((j) => rec(j).status === 'completed') && jobs.some((j) => rec(j).name === FINAL_JOB);
}

const round = (n: number): number => Math.round(n * 1e6) / 1e6;

/** Today's (UTC) implement spend. Never throws for unreadable data: that's { aic: null }. */
/** The task in an AI workflow run's name (`Implement <task> #<issue> attempt <n>`, `Repair …`), or null. */
export function taskOfRun(run: Rec): string | null {
  const title = typeof run.display_title === 'string' ? run.display_title : '';
  const m = /^(?:Implement|Repair) ([a-z0-9-]+(?:\/[a-z0-9-]+)+) #[1-9][0-9]{0,8} attempt [1-9][0-9]?$/.exec(title);
  return m ? m[1]! : null;
}

/**
 * Spend of the AI workflows: today's (UTC) total (the daily budget), and per task over today and
 * yesterday (the per-task budget; a task lives at most max_wall_clock_hours). Never throws for
 * unreadable data: today's total is then { aic: null }; an unreadable run from yesterday only makes
 * the per-task spend unknown (`tasks: null`), so repairs fail closed while dispatch goes on.
 */
/** Whether the workflow file as of `headSha` enforces exactly the policy's caps (spend bound only). */
export type LockVerifier = (workflowFile: string, headSha: string) => Promise<boolean>;

/** GitHub lets a run be re-run for 30 days: older runs can't spend again. */
export const RERUN_HORIZON_DAYS = 30;

export async function readSpendToday(client: GitHubClient, repo: string, now: Date, caps: SpendCaps, opts: SpendOptions = {}): Promise<SpendResult> {
  const bounding = opts.bounding ?? null;
  const verifyLock = opts.verifyLock ?? null;
  const dispatches = opts.dispatches ?? [];
  const day = now.toISOString().slice(0, 10);
  const yesterday = new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const horizon = new Date(Date.parse(`${day}T00:00:00Z`) - RERUN_HORIZON_DAYS * 86_400_000).toISOString().slice(0, 10);
  const runs: RunSpend[] = [];
  const unknown = (reason: string, alert: BoundAlert | null = null): SpendResult => ({ aic: null, runs, reason, tasks: null, alert });
  // Every AI workflow with its in-flight reservation (its two caps). A workflow whose runs can't be
  // listed (including a missing workflow file) makes spend unknown.
  const workflows = [
    { file: IMPLEMENT_WORKFLOW_FILE, reserve: caps.implement + caps.threat_detection },
    { file: REPAIR_WORKFLOW_FILE, reserve: caps.repair + caps.threat_detection },
    { file: REVIEW_WORKFLOW_FILE, reserve: caps.reviewer_agent + caps.threat_detection },
  ];
  const list: Rec[] = [];
  const reserveOf = new Map<Rec, number>();
  const fileOf = new Map<Rec, string>();
  for (const w of workflows) {
    try {
      const found = (
        // Back to the re-run horizon: an old run re-run today keeps its original created_at.
        await paginate(client, `/repos/${repo}/actions/workflows/${w.file}/runs?created=%3E%3D${horizon}&per_page=100`, (d) =>
          Array.isArray(rec(d).workflow_runs) ? (rec(d).workflow_runs as unknown[]) : [],
        )
      ).map(rec);
      for (const r of found) {
        reserveOf.set(r, w.reserve);
        fileOf.set(r, w.file);
      }
      list.push(...found);
    } catch (err) {
      return unknown(`${w.file} runs could not be listed (${(err as Error).message})`);
    }
  }
  // Measure everything first: one readable run that breaks an assumption turns bounding off for
  // all of them.
  const measured: { run: Rec; isToday: boolean; bound: number; r: RunSpend | string }[] = [];
  const verifiedLocks = new Map<string, boolean>();
  for (const run of list) {
    const id = run.id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return unknown('a run has no id');
    const created = typeof run.created_at === 'string' ? run.created_at : '';
    const started = typeof run.run_started_at === 'string' ? run.run_started_at : '';
    const rerun = typeof run.run_attempt === 'number' && run.run_attempt > 1;
    const isToday = created.startsWith(day) || (rerun && started.startsWith(day));
    const isYesterday = created.startsWith(yesterday) || (rerun && started.startsWith(yesterday));
    if (!isToday && !isYesterday) continue;
    const reserve = reserveOf.get(run)!;
    const bound = bounding ? reserve + 2 * bounding.margin : reserve;
    // The bound holds only for a run whose own commit's workflow enforces the policy's caps.
    const headSha = typeof run.head_sha === 'string' ? run.head_sha : '';
    const verified = async (): Promise<boolean> => {
      if (!bounding || !verifyLock || !/^[0-9a-f]{40}$/.test(headSha)) return false;
      const key = `${fileOf.get(run)!}@${headSha}`;
      let v = verifiedLocks.get(key);
      if (v === undefined) {
        v = await verifyLock(fileOf.get(run)!, headSha).catch(() => false);
        verifiedLocks.set(key, v);
      }
      return v;
    };
    measured.push({ run, isToday, bound, r: await measureRun(client, repo, run, id, bounding ? bound : reserve, bounding !== null, verified) });
  }
  let alert: BoundAlert | null = null;
  if (bounding) {
    for (const { r, bound } of measured) {
      if (typeof r === 'string') continue;
      if (r.status === 'bounded') {
        // A bounded run's readable records (a re-run's attempts, or the ones left beside a missing
        // totals file) must fit the assumptions too, and add up to no more than what it's counted at.
        if (r.max_concurrency === undefined || r.max_response_aic === undefined) continue;
        if (r.max_concurrency > bounding.max_concurrency || r.max_response_aic > bounding.max_response_aic || (r.responses_aic ?? 0) > r.aic) {
          alert = { code: 'overshoot_assumption_exceeded', run_id: r.run_id, max_concurrency: r.max_concurrency, max_response_aic: r.max_response_aic, aic: r.responses_aic ?? 0, bound: r.aic };
          break;
        }
        continue;
      }
      if (r.status !== 'measured') continue;
      // A measured run whose per-response records can't be checked leaves the assumptions unverified.
      if (r.max_concurrency === undefined || r.max_response_aic === undefined) {
        alert = { code: 'overshoot_unverifiable', run_id: r.run_id, max_concurrency: 0, max_response_aic: 0, aic: r.aic, bound };
        break;
      }
      const conc = r.max_concurrency;
      const resp = r.max_response_aic;
      if (conc > bounding.max_concurrency || resp > bounding.max_response_aic || r.aic > bound) {
        alert = { code: 'overshoot_assumption_exceeded', run_id: r.run_id, max_concurrency: conc, max_response_aic: resp, aic: r.aic, bound };
        break;
      }
    }
  }
  const byTask: Record<string, number> = {};
  let unattributed = 0;
  let taskUnknown = false;
  const unknownTasks = new Set<string>();
  for (const { run, isToday, r: measuredRun } of measured) {
    let r = measuredRun;
    if (alert && typeof r !== 'string' && r.status === 'bounded') {
      r = `run ${r.run_id} would count at its bound, but run ${alert.run_id} ${alert.code === 'overshoot_unverifiable' ? 'can\'t be checked against the overshoot assumptions' : 'broke an overshoot assumption'}: bounding is off`;
    }
    if (typeof r === 'string') {
      if (isToday) return unknown(r, alert);
      // Yesterday's run: only per-task spend is unknown, and only its own task's when the audit log
      // shows the controller dispatched it; otherwise every task's.
      const task = attributedTask(run, dispatches);
      if (task) unknownTasks.add(task);
      else taskUnknown = true;
      continue;
    }
    if (isToday) runs.push(r);
    const task = taskOfRun(run);
    if (task) byTask[task] = round((byTask[task] ?? 0) + r.aic);
    else unattributed = round(unattributed + r.aic); // counts against every task
  }
  return { aic: round(runs.reduce((s, r) => s + r.aic, 0)), runs, tasks: taskUnknown ? null : { by_task: byTask, unattributed, unknown_tasks: [...unknownTasks].sort() }, alert };
}

/** The `agent` artifact's own agent_usage.json, for logging only; undefined if unreadable. */
async function observedAgentAIC(client: GitHubClient, repo: string, artifacts: Rec[]): Promise<number | undefined> {
  try {
    const agent = artifacts.filter((a) => a.name === 'agent' && a.expired === false && typeof a.id === 'number');
    if (agent.length !== 1) return undefined;
    if (typeof agent[0]!.size_in_bytes === 'number' && agent[0]!.size_in_bytes > MAX_ARTIFACT_BYTES) return undefined;
    const res = await client.request('GET', `/repos/${repo}/actions/artifacts/${String(agent[0]!.id)}/zip`, { accept: 'binary' });
    if (!(res.data instanceof Uint8Array)) return undefined;
    const text = readZip(res.data, ['agent_usage.json']).get('agent_usage.json');
    const credits = text === undefined ? undefined : (JSON.parse(text) as { ai_credits?: unknown } | null)?.ai_credits;
    return isAIC(credits) ? round(credits) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One run's spend (reserved, measured, no inference, bounded), or the reason it can't be read.
 * `bound`: this run's bound when bounding is in force, else null (re-runs and missing usage are
 * then unknown).
 */
/** Every job's per-response record file a usage artifact may hold. */
const RECORD_FILES = ['agent/token_usage.jsonl', 'detection/token_usage.jsonl', 'evals/token_usage.jsonl'];

/**
 * Response statistics from every readable `usage` artifact of a run (all attempts), for the
 * assumption guard only; undefined when none can be read. Never used for accounting.
 */
async function readableStats(client: GitHubClient, repo: string, artifacts: Rec[]): Promise<{ max_concurrency: number; max_response_aic: number; responses_aic: number } | undefined> {
  let out: { max_concurrency: number; max_response_aic: number; responses_aic: number } | undefined;
  for (const a of artifacts.filter((x) => x.name === USAGE_ARTIFACT && x.expired === false && typeof x.id === 'number')) {
    try {
      if (typeof a.size_in_bytes === 'number' && a.size_in_bytes > MAX_ARTIFACT_BYTES) continue;
      const res = await client.request('GET', `/repos/${repo}/actions/artifacts/${String(a.id)}/zip`, { accept: 'binary' });
      if (!(res.data instanceof Uint8Array)) continue;
      const st = responseStats(readZip(res.data, RECORD_FILES));
      if (!st) continue;
      out = out
        ? { max_concurrency: Math.max(out.max_concurrency, st.max_concurrency), max_response_aic: Math.max(out.max_response_aic, st.max_response_aic), responses_aic: round(out.responses_aic + st.responses_aic) }
        : st;
    } catch {
      // unreadable: nothing to check from it
    }
  }
  return out;
}

const listArtifacts = async (client: GitHubClient, repo: string, id: number): Promise<Rec[]> =>
  (await paginate(client, `/repos/${repo}/actions/runs/${id}/artifacts?per_page=100`, (d) => (Array.isArray(rec(d).artifacts) ? (rec(d).artifacts as unknown[]) : []))).map(rec);

/**
 * One run's spend (reserved, measured, no inference, bounded), or the reason it can't be read.
 * `reserve`: the run's bound when `bounding` is in force, else its two caps. Anything that relies
 * on the bound (a re-run, missing usage, an in-flight reservation under a bound) needs
 * `verified()`: the run's own commit's workflow enforces the policy's caps.
 */
async function measureRun(client: GitHubClient, repo: string, run: Rec, id: number, reserve: number, bounding: boolean, verified: () => Promise<boolean>): Promise<RunSpend | string> {
  const bound = reserve;
  const attempt = run.run_attempt;
  if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 1 || attempt > MAX_ATTEMPTS) {
    return `run ${id} has an unexpected run_attempt (${String(attempt)})`;
  }
  // A re-run (even one still queued or running) carries earlier attempts' spend: n × the bound.
  // Its readable records still go to the assumption guard.
  if (attempt > 1) {
    if (!bounding || !(await verified())) return `run ${id} was re-run (attempt ${attempt}) and no spend bound is in force for its commit`;
    const stats = await readableStats(client, repo, await listArtifacts(client, repo, id).catch(() => []));
    return { run_id: id, status: 'bounded', aic: round(bound * attempt), reason: 'rerun', ...(stats ?? {}) };
  }
  const listJobs = async (): Promise<Rec[]> =>
    (await paginate(client, `/repos/${repo}/actions/runs/${id}/attempts/1/jobs?per_page=100`, (d) => (Array.isArray(rec(d).jobs) ? (rec(d).jobs as unknown[]) : []))).map(rec);
  let jobs: Rec[] | null = null;
  if (run.status !== 'completed') {
    try {
      jobs = await listJobs();
    } catch {
      jobs = null; // can't tell: keep the reservation
    }
    if (!jobs || !allJobsFinished(jobs)) {
      // Under a bound the reservation is the bound, which holds only for a verified commit.
      if (bounding && !(await verified())) return `run ${id} is in flight and its commit's caps can't be verified`;
      return { run_id: id, status: 'reserved', aic: reserve };
    }
  }
  let artifacts: Rec[] = [];
  let files: Map<string, string> | null = null;
  try {
    jobs ??= await listJobs();
    const inferred = jobs.filter(jobInferred).map((j) => String(j.name));
    const bad = inferred.find((n) => !JOB_NAME.test(n));
    if (bad !== undefined) return `run ${id} has a job with an unexpected name`;
    if (inferred.length === 0) return { run_id: id, status: 'no_inference', aic: 0 };
    artifacts = await listArtifacts(client, repo, id);
    const usage = artifacts.filter((a) => a.name === USAGE_ARTIFACT);
    if (usage.length === 0) throw new UsageMissing('no_usage_artifact', 'no usage artifact');
    if (usage.length !== 1) return `run ${id} has ${usage.length} usage artifacts`;
    const a = usage[0]!;
    if (a.expired === true) throw new UsageMissing('usage_artifact_expired', 'its usage artifact expired');
    if (a.expired !== false || typeof a.id !== 'number' || !Number.isSafeInteger(a.id)) return `run ${id}'s usage artifact is expired or has no id`;
    if (typeof a.size_in_bytes === 'number' && a.size_in_bytes > MAX_ARTIFACT_BYTES) return `run ${id}'s usage artifact is too large`;
    const res = await client.request('GET', `/repos/${repo}/actions/artifacts/${a.id}/zip`, { accept: 'binary' });
    if (!(res.data instanceof Uint8Array)) return `run ${id}'s usage artifact could not be downloaded`;
    const wanted = [...new Set([...inferred.map(usageFileFor), ...inferred.map((j) => `${j}/token_usage.jsonl`), ...RECORD_FILES])];
    files = readZip(res.data, wanted);
    const aic = runAIC(files, inferred);
    // The assumptions can be checked only if every job that called the model left records.
    const stats = responseStats(files, inferred);
    return { run_id: id, status: 'measured', aic: round(aic), ...(stats ?? {}) };
  } catch (err) {
    // Only a run GitHub reports as completed: nothing more can start in it, so its bound holds.
    if (err instanceof UsageMissing && run.status === 'completed' && bounding && (await verified())) {
      const observed = await observedAgentAIC(client, repo, artifacts);
      // Records that are present still go to the assumption guard.
      const stats = files ? responseStats(files) : null;
      return { run_id: id, status: 'bounded', aic: bound, reason: err.code, ...(observed !== undefined ? { observed_aic: observed } : {}), ...(stats ?? {}) };
    }
    return `run ${id}'s spend could not be read (${(err as Error).message})`;
  }
}

/** The `spend_snapshot` audit event fields (sources listed by run id, at most 50). */
export function spendSnapshotFields(day: string, spend: { aic: number; runs: RunSpend[] }): JsonObject {
  return {
    day,
    aic_today: spend.aic,
    runs: spend.runs.slice(0, 50).map((r) => ({
      run_id: r.run_id,
      status: r.status,
      aic: r.aic,
      ...(r.reason ? { reason: r.reason } : {}),
      ...(r.max_concurrency !== undefined ? { max_concurrency: r.max_concurrency } : {}),
      ...(r.max_response_aic !== undefined ? { max_response_aic: r.max_response_aic } : {}),
      ...(r.observed_aic !== undefined ? { observed_aic: r.observed_aic } : {}),
      ...(r.responses_aic !== undefined ? { responses_aic: r.responses_aic } : {}),
    })),
    runs_total: spend.runs.length,
  };
}
