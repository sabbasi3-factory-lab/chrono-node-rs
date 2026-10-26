// Controller entrypoint (no AI).
//   load policies → read audit log → snapshot → observe → plan → execute (live) or log
//   (dry-run) decisions → append audit events → Project status sync → heartbeat.
// Live only when FACTORY_ENABLED is exactly "true" (executor.ts lists the effects);
// otherwise dry-run, exactly as v1.
//
// Usage:
//   node main.ts                                   (CI; needs GH_TOKEN etc.)
//   node main.ts --fixture test/fixtures/snapshot.json --print [--now <iso>]

import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuditLog, AuditValidationError, dedupeKey, isoSeconds } from './audit.ts';
import { canonicalize } from './canonical.ts';
import { decisionEvent, execute, executeLive, isLive, liveDecision, pendingHandoffs } from './executor.ts';
import { FakeGitHub } from './fake.ts';
import { createClient, readSnapshot, REVIEWER_APP_ID, type RecordedCheck } from './github.ts';
import { heartbeatDue, heartbeatEvent } from './heartbeat.ts';
import { deriveState } from './history.ts';
import { OBSERVE_WINDOW_HOURS, observe } from './observe.ts';
import { statusContext, syncProject } from './project.ts';
import { readSpendToday, spendSnapshotFields } from './spend.ts';
import { isRecorded, killSwitchEnabled, missingStrictGates, plan } from './planner.ts';
import { loadPolicies, loadPoliciesFromDir, readFactoryVersion } from './policies.ts';
import type { AuditEvent, Decision, GitHubClient, PendingEvent, Policies, Snapshot } from './types.ts';

export const FACTORY_VERSION_FILE = new URL('../factory-version', import.meta.url);
export const FIXTURE_POLICIES_DIR = new URL('./test/fixtures/policies/', import.meta.url);

export interface RunEnv {
  FACTORY_ENABLED?: string | undefined;
  GITHUB_RUN_ID?: string | undefined;
  GITHUB_EVENT_NAME?: string | undefined;
}

export interface RunDeps {
  client: GitHubClient;
  repo: string;
  policies: Policies;
  factoryVersion: string;
  env: RunEnv;
  now: Date;
  log: (line: string) => void;
  /** Fixture mode: use this snapshot instead of reading GitHub. */
  snapshot?: Snapshot;
  /** Force dry-run whatever FACTORY_ENABLED says (fixture mode). */
  forceDryRun?: boolean;
  /** This run's URL, for comments (live mode). */
  runUrl?: string | null;
}

export interface RunResult {
  snapshot: Snapshot;
  decisions: Decision[];
  appended: AuditEvent[];
  summary: string;
  live: boolean;
}

export function recordedChecks(events: AuditEvent[]): Map<string, RecordedCheck> {
  const out = new Map<string, RecordedCheck>();
  for (const e of events) {
    if (e.type !== 'check_result') continue;
    const { run_id, run_attempt, heldout_seed, failure_signature, full_regression } = e.payload;
    if (typeof run_id !== 'number' || typeof run_attempt !== 'number') continue;
    out.set(`${run_id}/attempts/${run_attempt}`, {
      heldout_seed: typeof heldout_seed === 'string' ? heldout_seed : null,
      failure_signature: typeof failure_signature === 'string' ? failure_signature : null,
      full_regression: typeof full_regression === 'string' ? full_regression : null,
    });
  }
  return out;
}

function runId(env: RunEnv): number {
  const raw = env.GITHUB_RUN_ID ?? '0';
  if (!/^[0-9]{1,20}$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error('GITHUB_RUN_ID is not a number');
  return Number(raw);
}

function trigger(env: RunEnv): string {
  const t = env.GITHUB_EVENT_NAME ?? 'local';
  return /^[a-z_]{1,40}$/.test(t) ? t : 'unknown';
}

export function renderSummary(decisions: Decision[], appended: AuditEvent[], factoryEnabled: boolean, live = false, spend: string | null = null, project: string | null = null): string {
  const cell = (v: string | number | null): string => (v === null ? '' : String(v));
  const lines = [
    `## Factory controller (${live ? 'live' : 'dry-run'})`,
    '',
    `Kill switch: ${factoryEnabled ? 'dispatch allowed (`FACTORY_ENABLED=true`)' : 'dispatch blocked'}`,
    ...(spend ? [`Spend today: ${spend}`] : []),
    ...(project ? [`Project status: ${project}`] : []),
    '',
  ];
  if (decisions.length === 0) {
    lines.push('No decisions.');
  } else {
    lines.push(`| # | type | reason | ${live ? 'effect' : 'would'} | task | issue | PR |`, '|---|---|---|---|---|---|---|');
    decisions.forEach((d, i) => {
      lines.push(
        `| ${i + 1} | ${d.type} | ${d.reason} | ${d.effect} | ${cell(d.task)} | ${d.issue === null ? '' : `#${d.issue}`} | ${d.pr === null ? '' : `#${d.pr}`} |`,
      );
    });
  }
  lines.push('', `Audit events appended: ${appended.length}`);
  for (const e of appended) lines.push(`- \`${e.type}\` ${e.sha.slice(0, 19)}…`);
  return `${lines.join('\n')}\n`;
}

export async function run(deps: RunDeps): Promise<RunResult> {
  const { client, repo, policies, now, log } = deps;
  const factoryEnabled = killSwitchEnabled({ FACTORY_ENABLED: deps.env.FACTORY_ENABLED });
  const live = !deps.forceDryRun && isLive({ FACTORY_ENABLED: deps.env.FACTORY_ENABLED });
  log(`mode: ${live ? 'live (FACTORY_ENABLED=true)' : 'dry-run'}`);

  const audit = new AuditLog(client, { repo, factoryVersion: deps.factoryVersion, dryRun: !live });
  await audit.load(now);
  const derived = deriveState(audit.events, now);

  const snapshot: Snapshot = deps.snapshot
    ? structuredClone(deps.snapshot)
    : await readSnapshot(client, {
        repo,
        now,
        windowHours: OBSERVE_WINDOW_HOURS,
        recordedChecks: recordedChecks(audit.events),
        historyTasks: Object.keys(derived.history),
        needBusyJobs: factoryEnabled,
        reviewerAppId: REVIEWER_APP_ID,
      });
  snapshot.history = { ...derived.history, ...snapshot.history };

  // Spend, measured before planning (fixture mode uses the snapshot's value). Unknown spend
  // means no dispatch: the planner waits on budget_unknown.
  let spendNote = 'fixture';
  if (deps.snapshot) {
    snapshot.factory_aic_today ??= derived.factory_aic_today;
  } else {
    const spend = await readSpendToday(client, repo, now, policies.budgets.per_run);
    snapshot.task_spend = spend.tasks;
    if (spend.aic === null) {
      snapshot.factory_aic_today = null;
      spendNote = `unknown: ${spend.reason}`;
    } else {
      snapshot.factory_aic_today = spend.aic;
      spendNote = `${spend.aic} AIC from ${spend.runs.length} implement run(s)`;
    }
    // A bound stands in for a missing measurement: say so every time (summary and log).
    const bounded = spend.runs.filter((r) => r.status === 'bounded');
    if (bounded.length > 0) {
      spendNote += `; WARNING: ${bounded.map((r) => `run ${r.run_id} counted at its bound ${r.aic} AIC (usage missing: ${r.reason ?? 'unknown'})`).join('; ')}`;
    }
    log(`spend today: ${spendNote}`);
    if (spend.aic !== null) {
      const day = isoSeconds(now).slice(0, 10);
      // A measurement, not a decision: recorded as real (dry_run: false) in both modes. A new
      // event only when the total or its sources change (dedupe on them).
      const sources = spend.runs.map((r) => `run:${r.run_id}:${r.status}:${r.aic}`);
      await audit.append({ type: 'spend_snapshot', source_ids: [`day:${day}`, `aic:${spend.aic}`, ...sources], fields: spendSnapshotFields(day, spend), dry_run: false }, now);
    }
  }

  const held = missingStrictGates(policies);
  if (policies.tiers.tiers['auto-strict'].start_as !== 'human' && held.length > 0) {
    log(`auto-strict promotion held: tiers.yaml lists strict gates this controller doesn't enforce (${held.join(', ')})`);
  }

  const observed = observe(snapshot, now);
  // In live mode the decisions are what the controller will actually do (a repair becomes a
  // human hand-off: there is no repair workflow), so the summary and result match the audit log.
  const planned = plan(snapshot, policies, { FACTORY_ENABLED: deps.env.FACTORY_ENABLED }, now);
  const decisions = live ? planned.map(liveDecision) : planned;
  if (!live) execute(decisions, log);

  // One bad input (an invalid payload) must not stop the run before the
  // heartbeat: skip and log that event. Other errors (API, chain) still fail.
  let skipped = 0;
  const appendOrSkip = async (ev: PendingEvent): Promise<void> => {
    try {
      await audit.append(ev, now);
    } catch (err) {
      if (!(err instanceof AuditValidationError)) throw err;
      skipped++;
      log(`skipped invalid audit event (${err.message})`);
    }
  };
  for (const ev of observed) await appendOrSkip(ev);
  if (live) {
    // Effects, each recorded right after it ran. An effect failure stops the run (fail closed);
    // an event that can't be recorded is rejected before its effect runs.
    await executeLive(decisions, {
      client,
      repo,
      log,
      runUrl: deps.runUrl ?? null,
      pending: pendingHandoffs(audit.events),
      isNew: (ev) => !audit.hasDedupeKey(dedupeKey(ev.type, ev.source_ids)),
      validate: (ev) => {
        audit.prepare(ev);
      },
      record: async (ev) => {
        await audit.append(ev, now);
      },
    });
  } else {
    for (const d of decisions) if (isRecorded(d)) await appendOrSkip(decisionEvent(d));
  }
  if (skipped > 0) log(`skipped ${skipped} invalid audit event(s)`);
  // Project "Factory status" (best-effort, never fails the run). Read after the effects, so issue
  // labels and closes from this run already show. Not in fixture mode (no Project there).
  let projectNote: string | null = null;
  if (!deps.snapshot) {
    const sync = await syncProject(client, repo, statusContext(snapshot, live ? decisions : []), live, log);
    const n = sync.changes.length;
    projectNote = sync.error
      ? `stopped after ${sync.applied} update(s): ${sync.error}`
      : live ? `${sync.applied} update(s)` : `${n} update(s) planned (dry-run)`;
  }
  if (heartbeatDue(audit.newestOfType('heartbeat'), now)) {
    await audit.append(
      heartbeatEvent(now, {
        run_id: runId(deps.env),
        trigger: trigger(deps.env),
        open_pr_count: snapshot.pulls.filter((p) => p.state === 'open').length,
        decision_count: decisions.length,
        factory_enabled: factoryEnabled,
      }),
      now,
    );
  }
  log(`appended ${audit.appended.length} audit event(s) at ${isoSeconds(now)}`);
  return { snapshot, decisions, appended: [...audit.appended], summary: renderSummary(decisions, audit.appended, factoryEnabled, live, spendNote, projectNote), live };
}

// ---------------------------------------------------------------- CLI

interface CliArgs {
  fixture: string | null;
  print: boolean;
  now: string | null;
}

export function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { fixture: null, print: false, now: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fixture') out.fixture = argv[++i] ?? null;
    else if (a === '--print') out.print = true;
    else if (a === '--now') out.now = argv[++i] ?? null;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (out.fixture === '') throw new Error('--fixture needs a path');
  return out;
}

async function cli(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const factoryVersion = await readFactoryVersion(FACTORY_VERSION_FILE);
  const log = (line: string): void => console.log(line);
  let deps: RunDeps;

  if (args.fixture) {
    const snapshot = JSON.parse(await readFile(resolve(args.fixture), 'utf8')) as Snapshot;
    const now = new Date(args.now ?? snapshot.fetched_at);
    deps = {
      client: new FakeGitHub(snapshot.repo),
      repo: snapshot.repo,
      policies: await loadPoliciesFromDir(FIXTURE_POLICIES_DIR),
      factoryVersion,
      env: { FACTORY_ENABLED: process.env.FACTORY_ENABLED, GITHUB_RUN_ID: '0', GITHUB_EVENT_NAME: 'local' },
      now,
      log,
      snapshot,
      forceDryRun: true,
    };
    log(`fixture mode: ${args.fixture} (in-memory audit branch, always dry-run, nothing leaves this process)`);
  } else {
    const repo = process.env.GITHUB_REPOSITORY ?? '';
    if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) throw new Error('GITHUB_REPOSITORY missing or invalid');
    const token = process.env.GH_TOKEN ?? '';
    if (!token) throw new Error('GH_TOKEN missing');
    // Policies before any GitHub call: if they can't be loaded, nothing is read or written.
    const policies = await loadPolicies(factoryVersion);
    const mode = isLive({ FACTORY_ENABLED: process.env.FACTORY_ENABLED }) ? 'live' : 'dry-run';
    const server = process.env.GITHUB_SERVER_URL ?? 'https://github.com';
    const ghRun = process.env.GITHUB_RUN_ID;
    deps = {
      client: createClient(token, repo, fetch, mode),
      runUrl: ghRun && /^[0-9]{1,20}$/.test(ghRun) ? `${server}/${repo}/actions/runs/${ghRun}` : null,
      repo,
      policies,
      factoryVersion,
      env: {
        FACTORY_ENABLED: process.env.FACTORY_ENABLED,
        GITHUB_RUN_ID: process.env.GITHUB_RUN_ID,
        GITHUB_EVENT_NAME: process.env.GITHUB_EVENT_NAME,
      },
      now: new Date(),
      log,
    };
  }

  const result = await run(deps);
  if (args.print) {
    console.log('--- events that would be appended to the audit branch ---');
    for (const e of result.appended) console.log(canonicalize(e));
  }
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile && !args.fixture) await appendFile(summaryFile, result.summary);
  else if (!args.print) console.log(result.summary);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().catch((err: unknown) => {
    console.error(`controller failed (fail closed): ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
