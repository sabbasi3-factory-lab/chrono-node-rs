// Spend collector (DESIGN §11, policies/budgets.yaml). Before planning, every controller run
// measures today's (UTC) factory spend from the implement workflow's own accounting, and
// records it as a `spend_snapshot`. Plain code, no AI, read-only API calls.
//
// Per run of the AI workflows (implement, and repair) created today (UTC):
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
// If any completed run's spend can't be read (no artifact, expired, malformed, a re-run, an API
// error), today's spend is UNKNOWN and the planner dispatches nothing (fail closed). No runs → 0.

import { crc32, inflateRawSync } from 'node:zlib';
import { paginate } from './github.ts';
import type { GitHubClient, JsonObject } from './types.ts';

export const IMPLEMENT_WORKFLOW_FILE = 'implement.lock.yml';
export const REPAIR_WORKFLOW_FILE = 'repair.lock.yml';
export const USAGE_ARTIFACT = 'usage';
/** The implement workflow's last job: it needs every other job. */
export const FINAL_JOB = 'conclusion';
export const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
const MAX_ENTRIES = 1000;
const JOB_NAME = /^[a-z][a-z0-9_]{0,39}$/;

export interface RunSpend {
  run_id: number;
  status: 'reserved' | 'measured' | 'no_inference';
  aic: number;
}

/** Per-task AIC (today and yesterday): by task id, plus runs that name no task (count against every task). */
export interface TaskSpend {
  by_task: Record<string, number>;
  unattributed: number;
}

export type SpendResult = { aic: number; runs: RunSpend[]; tasks: TaskSpend | null } | { aic: null; runs: RunSpend[]; reason: string; tasks: null };

export interface SpendCaps {
  /** budgets.yaml per_run.implement */
  implement: number;
  /** budgets.yaml per_run.repair */
  repair: number;
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
  for (const job of inferredJobs) {
    const file = usageFileFor(job);
    const text = files.get(file);
    if (text === undefined) throw new Error(`${job} made model calls but ${file} is missing`);
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
  return aic;
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
export async function readSpendToday(client: GitHubClient, repo: string, now: Date, caps: SpendCaps): Promise<SpendResult> {
  const day = now.toISOString().slice(0, 10);
  const yesterday = new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const runs: RunSpend[] = [];
  const unknown = (reason: string): SpendResult => ({ aic: null, runs, reason, tasks: null });
  // Every AI workflow with its in-flight reservation. A workflow whose runs can't be listed
  // (including a missing workflow file) makes spend unknown.
  const workflows = [
    { file: IMPLEMENT_WORKFLOW_FILE, reserve: caps.implement + caps.threat_detection },
    { file: REPAIR_WORKFLOW_FILE, reserve: caps.repair + caps.threat_detection },
  ];
  const list: Rec[] = [];
  const reserveOf = new Map<Rec, number>();
  for (const w of workflows) {
    try {
      const found = (
        await paginate(client, `/repos/${repo}/actions/workflows/${w.file}/runs?created=%3E%3D${yesterday}&per_page=100`, (d) =>
          Array.isArray(rec(d).workflow_runs) ? (rec(d).workflow_runs as unknown[]) : [],
        )
      ).map(rec);
      for (const r of found) reserveOf.set(r, w.reserve);
      list.push(...found);
    } catch (err) {
      return unknown(`${w.file} runs could not be listed (${(err as Error).message})`);
    }
  }
  const byTask: Record<string, number> = {};
  let unattributed = 0;
  let taskUnknown = false;
  for (const run of list) {
    const id = run.id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return unknown('a run has no id');
    const created = typeof run.created_at === 'string' ? run.created_at : '';
    const isToday = created.startsWith(day);
    if (!isToday && !created.startsWith(yesterday)) continue;
    const r = await measureRun(client, repo, run, id, reserveOf.get(run)!);
    if (typeof r === 'string') {
      if (isToday) return unknown(r);
      taskUnknown = true; // yesterday's run: only the per-task spend is unknown
      continue;
    }
    if (isToday) runs.push(r);
    const task = taskOfRun(run);
    if (task) byTask[task] = round((byTask[task] ?? 0) + r.aic);
    else unattributed = round(unattributed + r.aic); // counts against every task
  }
  return { aic: round(runs.reduce((s, r) => s + r.aic, 0)), runs, tasks: taskUnknown ? null : { by_task: byTask, unattributed } };
}

/** One run's spend (reserved, measured, no inference), or the reason it can't be read. */
async function measureRun(client: GitHubClient, repo: string, run: Rec, id: number, reserve: number): Promise<RunSpend | string> {
  // A re-run (even one still queued or running) carries earlier attempts' spend: unknown.
  if (run.run_attempt !== 1) return `run ${id} was re-run (attempt ${String(run.run_attempt)})`;
  const listJobs = async (): Promise<Rec[]> =>
    (await paginate(client, `/repos/${repo}/actions/runs/${id}/attempts/1/jobs?per_page=100`, (d) => (Array.isArray(rec(d).jobs) ? (rec(d).jobs as unknown[]) : []))).map(rec);
  let jobs: Rec[] | null = null;
  if (run.status !== 'completed') {
    try {
      jobs = await listJobs();
    } catch {
      jobs = null; // can't tell: keep the reservation
    }
    if (!jobs || !allJobsFinished(jobs)) return { run_id: id, status: 'reserved', aic: reserve };
  }
  try {
    jobs ??= await listJobs();
    const inferred = jobs.filter(jobInferred).map((j) => String(j.name));
    const bad = inferred.find((n) => !JOB_NAME.test(n));
    if (bad !== undefined) return `run ${id} has a job with an unexpected name`;
    if (inferred.length === 0) return { run_id: id, status: 'no_inference', aic: 0 };
    const artifacts = (
      await paginate(client, `/repos/${repo}/actions/runs/${id}/artifacts?per_page=100`, (d) => (Array.isArray(rec(d).artifacts) ? (rec(d).artifacts as unknown[]) : []))
    ).map(rec);
    const usage = artifacts.filter((a) => a.name === USAGE_ARTIFACT);
    if (usage.length !== 1) return `run ${id} has ${usage.length} usage artifacts`;
    const a = usage[0]!;
    if (a.expired !== false || typeof a.id !== 'number' || !Number.isSafeInteger(a.id)) return `run ${id}'s usage artifact is expired or has no id`;
    if (typeof a.size_in_bytes === 'number' && a.size_in_bytes > MAX_ARTIFACT_BYTES) return `run ${id}'s usage artifact is too large`;
    const res = await client.request('GET', `/repos/${repo}/actions/artifacts/${a.id}/zip`, { accept: 'binary' });
    if (!(res.data instanceof Uint8Array)) return `run ${id}'s usage artifact could not be downloaded`;
    const aic = runAIC(readZip(res.data, inferred.map(usageFileFor)), inferred);
    return { run_id: id, status: 'measured', aic: round(aic) };
  } catch (err) {
    return `run ${id}'s spend could not be read (${(err as Error).message})`;
  }
}

/** The `spend_snapshot` audit event fields (sources listed by run id, at most 50). */
export function spendSnapshotFields(day: string, spend: { aic: number; runs: RunSpend[] }): JsonObject {
  return {
    day,
    aic_today: spend.aic,
    runs: spend.runs.slice(0, 50).map((r) => ({ run_id: r.run_id, status: r.status, aic: r.aic })),
    runs_total: spend.runs.length,
  };
}
