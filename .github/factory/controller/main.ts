// Controller v1 entrypoint (dry-run only, no AI).
//   load policies → read audit log → snapshot → observe → plan → log
//   decisions → append audit events → heartbeat.
//
// Usage:
//   node main.ts                                   (CI; needs GH_TOKEN etc.)
//   node main.ts --fixture test/fixtures/snapshot.json --print [--now <iso>]

import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuditLog, isoSeconds } from './audit.ts';
import { canonicalize } from './canonical.ts';
import { decisionEvent, DRY_RUN, execute } from './executor.ts';
import { FakeGitHub } from './fake.ts';
import { createClient, readSnapshot, type RecordedCheck } from './github.ts';
import { heartbeatDue, heartbeatEvent } from './heartbeat.ts';
import { deriveState } from './history.ts';
import { OBSERVE_WINDOW_HOURS, observe } from './observe.ts';
import { isRecorded, killSwitchEnabled, plan } from './planner.ts';
import { loadPolicies, loadPoliciesFromDir, readFactoryVersion } from './policies.ts';
import type { AuditEvent, Decision, GitHubClient, Policies, Snapshot } from './types.ts';

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
}

export interface RunResult {
  snapshot: Snapshot;
  decisions: Decision[];
  appended: AuditEvent[];
  summary: string;
}

function recordedChecks(events: AuditEvent[]): Map<string, RecordedCheck> {
  const out = new Map<string, RecordedCheck>();
  for (const e of events) {
    if (e.type !== 'check_result') continue;
    const { run_id, run_attempt, heldout_seed, failure_signature } = e.payload;
    if (typeof run_id !== 'number' || typeof run_attempt !== 'number') continue;
    out.set(`${run_id}/attempts/${run_attempt}`, {
      heldout_seed: typeof heldout_seed === 'string' ? heldout_seed : null,
      failure_signature: typeof failure_signature === 'string' ? failure_signature : null,
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

export function renderSummary(decisions: Decision[], appended: AuditEvent[], factoryEnabled: boolean): string {
  const cell = (v: string | number | null): string => (v === null ? '' : String(v));
  const lines = [
    '## Factory controller v1 (dry-run)',
    '',
    `Kill switch: ${factoryEnabled ? 'dispatch allowed (`FACTORY_ENABLED=true`)' : 'dispatch blocked'}`,
    '',
  ];
  if (decisions.length === 0) {
    lines.push('No decisions.');
  } else {
    lines.push('| # | type | reason | would | task | issue | PR |', '|---|---|---|---|---|---|---|');
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
  if (DRY_RUN !== true) throw new Error('controller v1 must run in dry-run mode');
  const { client, repo, policies, now, log } = deps;
  const factoryEnabled = killSwitchEnabled({ FACTORY_ENABLED: deps.env.FACTORY_ENABLED });

  const audit = new AuditLog(client, { repo, factoryVersion: deps.factoryVersion });
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
      });
  snapshot.history = { ...derived.history, ...snapshot.history };
  snapshot.factory_aic_today ??= derived.factory_aic_today;

  const observed = observe(snapshot, now);
  const decisions = plan(snapshot, policies, { FACTORY_ENABLED: deps.env.FACTORY_ENABLED }, now);
  execute(decisions, log);

  for (const ev of observed) await audit.append(ev, now);
  for (const d of decisions) if (isRecorded(d)) await audit.append(decisionEvent(d), now);
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
  return { snapshot, decisions, appended: [...audit.appended], summary: renderSummary(decisions, audit.appended, factoryEnabled) };
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
    };
    log(`fixture mode: ${args.fixture} (in-memory audit branch, nothing leaves this process)`);
  } else {
    const repo = process.env.GITHUB_REPOSITORY ?? '';
    if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) throw new Error('GITHUB_REPOSITORY missing or invalid');
    const token = process.env.GH_TOKEN ?? '';
    if (!token) throw new Error('GH_TOKEN missing');
    // Policies before any GitHub call: if they can't be loaded, nothing is read or written.
    const policies = await loadPolicies(factoryVersion);
    deps = {
      client: createClient(token, repo),
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
