// Outcomes collector (no AI, no App key): `.github/workflows/outcomes.yml` runs this with the job's
// read-only GITHUB_TOKEN. It lists every completed agent run (implement, repair, review), picks
// the ones to (re)evaluate against the newest `outcomes_snapshot` on the audit branch, runs the
// pinned gh-aw's `outcomes <run-id>` for them (bounded parallelism, per-run timeout), and writes
// one complete snapshot (every run) for the controller to ingest. See outcomes.ts.
//
// Usage:
//   node collect-outcomes.ts --out <file> [--work <dir>] [--full] [--concurrency 4] [--timeout 180]
// Env: GH_TOKEN, GITHUB_REPOSITORY, GH_AW_BIN (default `gh-aw`), OUTCOMES_FULL=true (same as --full).

import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuditLog } from './audit.ts';
import { createClient, paginate } from './github.ts';
import {
  buildSnapshot,
  diagnosisFromAudit,
  itemsFromGhAw,
  matchReviewRuns,
  needsDiagnosis,
  reviewDispatches,
  previousRuns,
  referencedNumbers,
  runRecord,
  runsHash,
  selectRuns,
  taskFromPr,
  taskFromReference,
  taskFromTitle,
  validateSnapshot,
  workflowOfPath,
  AGENT_WORKFLOWS,
  RUN_CONCLUSIONS,
  type Diagnosis,
  type EvalResult,
  type ReviewDispatch,
  type ListedRun,
  type OutcomeRun,
  type OutcomesSnapshot,
  type Trigger,
} from './outcomes.ts';
import { AGENT_LOGIN } from './planner.ts';
import type { GitHubClient } from './types.ts';

/** Runs the gh-aw binary with these arguments; resolves with stdout. */
export type GhAw = (args: string[], opts: { input?: string; timeoutMs: number }) => Promise<string>;

export interface CollectDeps {
  client: GitHubClient;
  repo: string;
  ghAw: GhAw;
  now: Date;
  full: boolean;
  /** What started this collection (default: the daily sweep). */
  trigger?: Trigger;
  workDir: string;
  concurrency?: number;
  timeoutMs?: number;
  log: (line: string) => void;
  /** Previous runs (tests); default: read the newest outcomes_snapshot from the audit branch. */
  previous?: Map<number, OutcomeRun> | null;
  /** The controller's review dispatches (tests); default: read from the audit branch with `previous`. */
  reviewDispatches?: ReviewDispatch[];
}

/** Every completed run of the three agent workflows, newest first. */
export async function listAgentRuns(client: GitHubClient, repo: string): Promise<ListedRun[]> {
  const out: ListedRun[] = [];
  for (const wf of AGENT_WORKFLOWS) {
    const runs = await paginate(client, `/repos/${repo}/actions/workflows/${wf}.lock.yml/runs?status=completed&per_page=100`, (d) => {
      const r = (d as { workflow_runs?: unknown } | null)?.workflow_runs;
      return Array.isArray(r) ? (r as Record<string, unknown>[]) : [];
    });
    for (const r of runs) {
      const id = r.id;
      const workflow = workflowOfPath(r.path);
      const created = typeof r.created_at === 'string' ? r.created_at.replace(/\.\d+Z$/, 'Z') : '';
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) throw new Error(`a ${wf} run has no id`);
      if (workflow !== wf) throw new Error(`run ${id} has an unexpected path`);
      if (r.status !== 'completed') continue;
      if (!(RUN_CONCLUSIONS as readonly unknown[]).includes(r.conclusion)) throw new Error(`run ${id} has an unexpected conclusion ${String(r.conclusion)}`);
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(created)) throw new Error(`run ${id} has no created_at`);
      out.push({ run_id: id, workflow, title: typeof r.display_title === 'string' ? r.display_title : '', created_at: created, conclusion: r.conclusion as string });
    }
  }
  return out.sort((a, b) => b.run_id - a.run_id);
}

/** Runs `fn` over `items` with at most `limit` in flight. */
export async function pool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/** gh-aw's `aic` per run, from one `gh aw logs --stdin --json` call. Missing runs are absent. */
export async function readAic(ghAw: GhAw, repo: string, runIds: readonly number[], workDir: string, log: (l: string) => void): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (runIds.length === 0) return out;
  try {
    const stdout = await ghAw(['logs', '--stdin', '--repo', repo, '--json', '-c', String(runIds.length), '-o', join(workDir, 'logs')], {
      input: `${runIds.join('\n')}\n`,
      timeoutMs: 60_000 + 10_000 * runIds.length,
    });
    const runs = (JSON.parse(stdout) as { runs?: unknown }).runs;
    for (const r of Array.isArray(runs) ? runs : []) {
      const { run_id, aic } = (r ?? {}) as { run_id?: unknown; aic?: unknown };
      if (typeof run_id === 'number' && runIds.includes(run_id) && typeof aic === 'number' && Number.isFinite(aic) && aic >= 0) out.set(run_id, Math.round(aic * 1e6) / 1e6);
    }
  } catch (err) {
    log(`aic: gh aw logs failed (${(err as Error).message.split('\n')[0]}); aic stays as before (or null)`);
  }
  return out;
}

export async function collect(deps: CollectDeps): Promise<{ snapshot: OutcomesSnapshot; failures: { run_id: number; error: string }[] }> {
  const { client, repo, ghAw, now, log } = deps;
  const concurrency = deps.concurrency ?? 4;
  const timeoutMs = deps.timeoutMs ?? 180_000;
  let previous = deps.previous;
  let dispatches = deps.reviewDispatches ?? [];
  if (previous === undefined) {
    const audit = new AuditLog(client, { repo, factoryVersion: 'collector', historyDays: 14 });
    await audit.load(now);
    previous = previousRuns(audit, repo);
    dispatches = deps.reviewDispatches ?? reviewDispatches(audit.events);
  }
  log(previous ? `previous snapshot: ${previous.size} run(s)` : 'previous snapshot: none (full backfill)');
  const listed = await listAgentRuns(client, repo);
  const trigger = deps.trigger ?? { kind: 'sweep' };
  const sel = selectRuns(listed, previous, now, deps.full, trigger);
  if (trigger.kind === 'run' && !listed.some((r) => r.run_id === trigger.run_id)) log(`run ${trigger.run_id} is not a completed agent run; nothing targeted`);
  log(`${listed.length} completed agent run(s): evaluating ${sel.evaluate.length}, carrying ${sel.carry.length} over (mode ${sel.mode})`);

  const results = new Map<number, EvalResult>();
  const failures: { run_id: number; error: string }[] = [];
  let dropped = 0;
  await pool(sel.evaluate, concurrency, async (run) => {
    try {
      const stdout = await ghAw(['outcomes', String(run.run_id), '--repo', repo, '--json', '-o', join(deps.workDir, 'outcomes')], { timeoutMs });
      const r = itemsFromGhAw(JSON.parse(stdout), run.run_id, repo);
      // gh-aw couldn't check an item: a failed evaluation (previous items kept as stale, retried),
      // never a settled `ok` that would replace good items.
      const errored = r.items.filter((i) => i.outcome_status === 'error').length;
      if (errored > 0) throw new Error(`gh-aw reported ${errored} item(s) with outcome_status error`);
      dropped += r.dropped_urls;
      results.set(run.run_id, { ok: true, items: r.items });
    } catch (err) {
      const error = (err as Error).message.split('\n')[0]!.slice(0, 300);
      failures.push({ run_id: run.run_id, error });
      results.set(run.run_id, { ok: false, error });
      log(`run ${run.run_id}: evaluation failed (${error})`);
    }
  });
  if (dropped > 0) log(`${dropped} object URL(s) outside this repo's PR/issue URL form were recorded as null`);

  // Every listed run still without credits, whether or not its outcomes are evaluated now: a failed
  // `gh aw logs` during a backfill is retried on the next collection, not only while unsettled.
  const needAic = listed.filter((r) => (previous?.get(r.run_id)?.aic ?? null) === null).map((r) => r.run_id);
  const aic = await readAic(ghAw, repo, needAic, deps.workDir, log);

  // gh-aw audit of implement runs that failed or opened no PR, once per run: a run with a diagnosis
  // keeps it; a failed audit stays null and is retried next collection.
  const diagnoses = new Map<number, Diagnosis>();
  const toAudit = listed.filter((run) => {
    if (previous?.get(run.run_id)?.diagnosis) return false;
    const result = results.get(run.run_id);
    return needsDiagnosis(run, result?.ok ? result.items : (previous?.get(run.run_id)?.items ?? []));
  });
  if (toAudit.length > 0) log(`auditing ${toAudit.length} implement run(s) without a PR or success`);
  await pool(toAudit, concurrency, async (run) => {
    try {
      const stdout = await ghAw(['audit', String(run.run_id), '--repo', repo, '--json', '--no-baseline', '-o', join(deps.workDir, 'audit')], { timeoutMs });
      diagnoses.set(run.run_id, diagnosisFromAudit(JSON.parse(stdout)));
    } catch (err) {
      log(`run ${run.run_id}: audit failed (${(err as Error).message.split('\n')[0]!.slice(0, 200)}); retried next collection`);
    }
  });

  // Review runs from before review.md had a run-name: the controller's review dispatch each followed.
  // Every review run takes part: titled ones and ones already attributed (listed or carried over
  // from the previous snapshot) reserve the dispatch of their own task, so a dispatch is never given
  // to a second run on a later collection. Only matches of runs without a task are applied below.
  const listedIds = new Set(listed.map((r) => r.run_id));
  const reviewTasks = matchReviewRuns(
    [
      ...listed.filter((r) => r.workflow === 'review').map((r) => ({ run_id: r.run_id, created_at: r.created_at, task: taskFromTitle(r.title) ?? previous?.get(r.run_id)?.task ?? null })),
      ...[...(previous?.values() ?? [])].filter((p) => p.workflow === 'review' && p.task !== null && !listedIds.has(p.run_id)),
    ],
    dispatches,
  );

  const refCache = new Map<string, string | null>();
  const runs: OutcomeRun[] = [];
  const evaluatedAt = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  for (const run of listed) {
    const prev = previous?.get(run.run_id);
    const result = results.get(run.run_id);
    let task = taskFromTitle(run.title) ?? prev?.task ?? reviewTasks.get(run.run_id)?.task ?? null;
    if (task === null) {
      const items = result?.ok ? result.items : (prev?.items ?? []);
      for (const ref of referencedNumbers(items)) {
        const key = `${ref.kind}/${ref.number}`;
        if (!refCache.has(key)) {
          try {
            refCache.set(key, await taskFromReference(client, repo, ref));
          } catch (err) {
            log(`run ${run.run_id}: task lookup via ${key} failed (${(err as Error).message})`);
            refCache.set(key, null);
          }
        }
        task = refCache.get(key) ?? null;
        if (task) break;
      }
    }
    runs.push(runRecord(run, prev, result, aic.get(run.run_id), task, evaluatedAt, diagnoses.get(run.run_id)));
  }
  // A previously recorded run missing from this listing (being re-run, so not `completed` right now,
  // or deleted) is carried forward unchanged, so the snapshot stays complete.
  const unlisted = previous ? [...previous.values()].filter((p) => !listedIds.has(p.run_id)) : [];
  if (unlisted.length > 0) log(`${unlisted.length} recorded run(s) not in the current listing carried over unchanged: ${unlisted.map((p) => p.run_id).join(', ')}`);
  runs.push(...unlisted);
  const snapshot = buildSnapshot(repo, now, sel.mode, runs);
  // Self-check against the controller's own validator: never upload what it would refuse.
  validateSnapshot(JSON.stringify(snapshot), repo);
  if (previous && runsHash([...previous.values()]) === runsHash(snapshot.runs)) log('unchanged since the previous snapshot: the controller will record only an outcomes_checked marker');
  return { snapshot, failures };
}

/**
 * The trigger from the workflow's env: OUTCOMES_PR (pull_request_target closed) or OUTCOMES_RUN_ID
 * (workflow_run), numbers only; neither is the daily sweep. A PR must be a closed agent PR; its
 * task comes from its `Factory-Task:` trailer, read through the API (never from the event).
 */
export async function resolveTrigger(client: GitHubClient, repo: string, env: Record<string, string | undefined>): Promise<Trigger> {
  const pr = env.OUTCOMES_PR ?? '';
  const run = env.OUTCOMES_RUN_ID ?? '';
  if (pr !== '' && run !== '') throw new Error('OUTCOMES_PR and OUTCOMES_RUN_ID are exclusive');
  if (run !== '') {
    if (!/^[1-9][0-9]{0,19}$/.test(run) || !Number.isSafeInteger(Number(run))) throw new Error('OUTCOMES_RUN_ID is not a run id');
    return { kind: 'run', run_id: Number(run) };
  }
  if (pr === '') return { kind: 'sweep' };
  if (!/^[1-9][0-9]{0,8}$/.test(pr)) throw new Error('OUTCOMES_PR is not a PR number');
  const data = (await client.request('GET', `/repos/${repo}/pulls/${pr}`)).data as { user?: { login?: unknown }; state?: unknown; title?: unknown; body?: unknown } | null;
  if (data?.user?.login !== `${AGENT_LOGIN}[bot]`) throw new Error(`PR #${pr} is not an agent PR`);
  if (data.state !== 'closed') throw new Error(`PR #${pr} is not closed`);
  return { kind: 'pr', pr: Number(pr), task: taskFromPr(data) };
}

// ---------------------------------------------------------------- CLI

export function ghAwExec(bin: string): GhAw {
  return (args, opts) =>
    new Promise((resolvePromise, reject) => {
      const child = execFile(bin, args, { timeout: opts.timeoutMs, maxBuffer: 64 * 1024 * 1024, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
        if (err) reject(new Error(`${err.message.split('\n')[0]}${stderr ? `: ${String(stderr).trim().split('\n').slice(-1)[0]}` : ''}`));
        else resolvePromise(String(stdout));
      });
      child.stdin?.end(opts.input ?? '');
    });
}

interface CliArgs {
  out: string;
  work: string;
  full: boolean;
  concurrency: number;
  timeout: number;
}

export function parseCollectArgs(argv: string[], env: Record<string, string | undefined>): CliArgs {
  const out: CliArgs = { out: '', work: '', full: env.OUTCOMES_FULL === 'true', concurrency: 4, timeout: 180 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.out = argv[++i] ?? '';
    else if (a === '--work') out.work = argv[++i] ?? '';
    else if (a === '--full') out.full = true;
    else if (a === '--concurrency') out.concurrency = Number(argv[++i]);
    else if (a === '--timeout') out.timeout = Number(argv[++i]);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!out.out) throw new Error('--out is required');
  if (!Number.isInteger(out.concurrency) || out.concurrency < 1 || out.concurrency > 16) throw new Error('--concurrency must be 1..16');
  if (!Number.isInteger(out.timeout) || out.timeout < 10 || out.timeout > 1800) throw new Error('--timeout must be 10..1800 seconds');
  out.work ||= join(dirname(resolve(out.out)), 'gh-aw-work');
  return out;
}

async function cli(): Promise<void> {
  const args = parseCollectArgs(process.argv.slice(2), process.env);
  const repo = process.env.GITHUB_REPOSITORY ?? '';
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) throw new Error('GITHUB_REPOSITORY missing or invalid');
  const token = process.env.GH_TOKEN ?? '';
  if (!token) throw new Error('GH_TOKEN missing');
  await mkdir(args.work, { recursive: true });
  const log = (line: string): void => console.log(line);
  // Read-only: the client's dry-run guard allows GETs, and this script never writes to GitHub.
  const client = createClient(token, repo, fetch, 'dry-run');
  const trigger = await resolveTrigger(client, repo, process.env);
  log(`trigger: ${trigger.kind === 'sweep' ? 'sweep' : trigger.kind === 'pr' ? `PR #${trigger.pr} (task ${trigger.task ?? 'unknown'})` : `run ${trigger.run_id}`}${args.full ? ', full' : ''}`);
  const { snapshot, failures } = await collect({
    client,
    trigger,
    repo,
    ghAw: ghAwExec(process.env.GH_AW_BIN || 'gh-aw'),
    now: new Date(),
    full: args.full,
    workDir: args.work,
    concurrency: args.concurrency,
    timeoutMs: args.timeout * 1000,
    log,
  });
  await mkdir(dirname(resolve(args.out)), { recursive: true });
  await writeFile(args.out, `${JSON.stringify(snapshot)}\n`);
  const s = snapshot.summary;
  log(`snapshot: ${s.runs} runs, ${s.items} items (accepted ${s.accepted}, rejected ${s.rejected}, ignored ${s.ignored}, pending ${s.pending}, unknown ${s.unknown}, other ${s.other}, zero_touch ${s.zero_touch}); stale ${s.eval_stale}, error ${s.eval_error}; ${failures.length} evaluation failure(s)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().catch((err: unknown) => {
    console.error(`outcomes collector failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
