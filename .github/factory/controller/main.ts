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
import { ALERT_TITLE, ALERT_TITLES, COMMENT_MARKER, createClient, LABEL_ALERT, paginate, readSnapshot, REVIEWER_APP_ID, type AlertCode, type RecordedCheck } from './github.ts';
import { CAPPED_WORKFLOWS, lockCapsMismatch, type CappedWorkflow } from './caps.ts';
import { dispatchStatus, stateChanged } from './dispatch-state.ts';
import { heartbeatDue, heartbeatEvent } from './heartbeat.ts';
import { deriveState } from './history.ts';
import { OBSERVE_WINDOW_HOURS, observe } from './observe.ts';
import { statusContext, syncProject } from './project.ts';
import { readSpendToday, spendSnapshotFields, type DispatchRecord } from './spend.ts';
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
  /** Tests: the compiled workflows to check the spend bound's caps against (default: the checkout's). */
  readLocks?: () => Promise<Record<CappedWorkflow, string | null>>;
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

/** The compiled AI workflows, as the controller's own checkout has them (null if unreadable). */
async function readLocks(): Promise<Record<CappedWorkflow, string | null>> {
  const out = {} as Record<CappedWorkflow, string | null>;
  for (const wf of Object.keys(CAPPED_WORKFLOWS) as CappedWorkflow[]) {
    try {
      out[wf] = await readFile(new URL(`../../workflows/${wf}.lock.yml`, import.meta.url), 'utf8');
    } catch {
      out[wf] = null;
    }
  }
  return out;
}

const EMPTY_LOCKS: Record<CappedWorkflow, string | null> = { implement: null, repair: null, review: null };

/** Titles of the open factory:alert issues (any open one keeps the spend bound off). */
async function openAlertTitles(client: GitHubClient, repo: string): Promise<string[]> {
  const open = await paginate(client, `/repos/${repo}/issues?state=open&labels=${encodeURIComponent(LABEL_ALERT)}&per_page=100`, (d) => (Array.isArray(d) ? d : []));
  // Only the controller's own alert issues count: labelled factory:alert, with one of its titles.
  return open
    .filter((i) => {
      const labels = (i as { labels?: unknown }).labels;
      return Array.isArray(labels) && labels.some((l) => (typeof l === 'string' ? l : (l as { name?: unknown })?.name) === LABEL_ALERT);
    })
    .map((i) => (i as { title?: unknown }).title)
    .filter((t): t is string => typeof t === 'string' && ALERT_TITLES.includes(t));
}

/** The controller's non-dry-run implement and repair dispatches, for attributing runs to tasks. */
function dispatchRecords(events: AuditEvent[]): DispatchRecord[] {
  const out: DispatchRecord[] = [];
  for (const e of events) {
    if ((e.type !== 'dispatched' && e.type !== 'repair_dispatched') || e.payload.dry_run !== false) continue;
    const { task, issue, attempt } = e.payload;
    if (typeof task !== 'string' || typeof issue !== 'number' || typeof attempt !== 'number') continue;
    out.push({ kind: e.type === 'dispatched' ? 'implement' : 'repair', task, issue, attempt, at: e.timestamp });
  }
  return out;
}

/** Opens the factory:alert issue for this cause (the caller checked none is open). */
async function raiseAlertIssue(client: GitHubClient, repo: string, code: AlertCode, note: string): Promise<void> {
  const title = ALERT_TITLE(code);
  const body = `${COMMENT_MARKER} · ${LABEL_ALERT}\n\nThe spend bound is off until a person reviews it (budgets.yaml per_run.overshoot_margin, or the compiled workflow caps). Until then a run whose usage can't be read blocks dispatch again.\n\n${note}`.slice(0, 2000);
  await client.request('POST', `/repos/${repo}/issues`, { body: { title, body, labels: [LABEL_ALERT] } });
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
  let unreadableRuns = 0;
  if (deps.snapshot) {
    snapshot.factory_aic_today ??= derived.factory_aic_today;
  } else {
    // The spend bound (spend.ts) only with the policy's overshoot margin AND compiled workflows that
    // enforce exactly the policy's caps; otherwise unreadable usage stays unknown.
    const overshoot = policies.budgets.per_run.overshoot ?? null;
    let lockMismatch: string | null = null;
    let openAlerts: string[] = [];
    if (overshoot) {
      lockMismatch = lockCapsMismatch(await (deps.readLocks ?? readLocks)(), policies.budgets.per_run);
      if (lockMismatch) log(`WARNING: spend bound off: ${lockMismatch}`);
      // An open factory:alert keeps the bound off until a person has reviewed it and closed it.
      openAlerts = await openAlertTitles(client, repo);
      if (openAlerts.length > 0) log(`WARNING: spend bound off: ${openAlerts.length} open ${LABEL_ALERT} issue(s)`);
    }
    const bounding = overshoot && !lockMismatch && openAlerts.length === 0 ? overshoot : null;
    const spend = await readSpendToday(client, repo, now, policies.budgets.per_run, {
      bounding,
      // A run executes its own commit's workflow: the bound holds only if that lock has the policy's caps.
      verifyLock: async (file, sha) => {
        const wf = file.replace(/\.lock\.yml$/, '') as CappedWorkflow;
        if (!(wf in CAPPED_WORKFLOWS)) return false;
        const res = await client.request('GET', `/repos/${repo}/contents/.github/workflows/${file}?ref=${sha}`, { accept: 'raw' });
        return typeof res.data === 'string' && lockCapsMismatch({ ...EMPTY_LOCKS, [wf]: res.data }, policies.budgets.per_run, [wf]) === null;
      },
      dispatches: dispatchRecords(audit.events),
    });
    snapshot.task_spend = spend.tasks;
    if (spend.aic === null) {
      snapshot.factory_aic_today = null;
      unreadableRuns = spend.unreadable_runs ?? 0;
      spendNote = `unknown: ${spend.reason}${unreadableRuns > 1 ? ` (${unreadableRuns} unreadable runs today)` : ''}`;
    } else {
      snapshot.factory_aic_today = spend.aic;
      spendNote = `${spend.aic} AIC from ${spend.runs.length} implement run(s)`;
    }
    // A bound stands in for a missing measurement: say so every time (summary and log).
    const bounded = spend.runs.filter((r) => r.status === 'bounded');
    if (bounded.length > 0) {
      spendNote += `; WARNING: ${bounded.map((r) => `run ${r.run_id} counted at its bound ${r.aic} AIC (${r.reason === 'rerun' ? 're-run' : `usage missing: ${r.reason ?? 'unknown'}`}${r.observed_aic !== undefined ? `; agent artifact says ${r.observed_aic} AIC` : ''})`).join('; ')}`;
    }
    if (spend.alert) {
      const a = spend.alert;
      spendNote +=
        a.code === 'overshoot_unverifiable'
          ? `; ALERT: run ${a.run_id}'s per-response records can't be checked against the overshoot assumptions: spend bound off`
          : `; ALERT: run ${a.run_id} broke an overshoot assumption (concurrency ${a.max_concurrency}, largest response ${a.max_response_aic} AIC, total ${a.aic} vs bound ${a.bound}): spend bound off`;
    }
    if (lockMismatch) spendNote += `; ALERT: spend bound off (${lockMismatch})`;
    log(`spend today: ${spendNote}`);
    // factory:alert: recorded (real in both modes, once a day per cause), and in live mode one open
    // issue for a person to review the margin or the caps.
    const alertDay = isoSeconds(now).slice(0, 10);
    const alerts: { code: AlertCode; source: string; fields: Record<string, number | string> }[] = [];
    if (spend.alert) alerts.push({ code: spend.alert.code, source: `run:${spend.alert.run_id}`, fields: { ...spend.alert } });
    if (lockMismatch) alerts.push({ code: 'lock_caps_mismatch', source: 'locks', fields: { code: 'lock_caps_mismatch' } });
    for (const al of alerts) {
      await audit.append({ type: 'alert', source_ids: [`day:${alertDay}`, al.code, al.source], fields: al.fields, dry_run: false }, now);
      // The issue follows the condition, not the (once-a-day) event: opened whenever none is open,
      // so a failed attempt is retried next poll. A failure here doesn't fail the run: the bound is
      // already off and the event is recorded.
      if (live && !openAlerts.includes(ALERT_TITLE(al.code))) {
        try {
          await raiseAlertIssue(client, repo, al.code, spendNote);
          openAlerts.push(ALERT_TITLE(al.code));
        } catch (err) {
          log(`WARNING: could not open the ${LABEL_ALERT} issue (${(err as Error).message}); retried next poll`);
        }
      }
    }
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

  // The control room's banner: what dispatching is doing, recorded only when it changes (so the
  // event's timestamp is "since"). Real in live mode; a dry run records it as dry-run.
  const status = dispatchStatus(planned, snapshot, { FACTORY_ENABLED: deps.env.FACTORY_ENABLED }, snapshot.factory_aic_today !== null && snapshot.factory_aic_today !== undefined, unreadableRuns);
  log(`dispatch: ${status.state}${status.reason === 'none' ? '' : ` (${status.reason})`}; ready ${status.ready}, in flight ${status.in_flight}${status.spend_known ? '' : `; spend unknown${status.unreadable_runs ? ` (${status.unreadable_runs} unreadable run(s))` : ''}`}`);
  if (stateChanged(audit.newestOfType('dispatch_state')?.payload ?? null, status)) {
    try {
      await audit.append({ type: 'dispatch_state', source_ids: [`state:${status.state}`, `reason:${status.reason}`, isoSeconds(now)], fields: { ...status }, dry_run: !live }, now);
    } catch (err) {
      if (!(err instanceof AuditValidationError)) throw err;
      log(`skipped invalid dispatch_state event (${err.message})`);
    }
  }

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
