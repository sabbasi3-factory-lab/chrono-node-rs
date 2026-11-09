// The planner (DESIGN §7): a PURE function from a snapshot of GitHub plus
// policies to a list of decisions with stable reason codes. No I/O, no clock
// reads (`now` is an argument), no randomness.

import { CONTROLLER_LOGIN, REVERT_REVIEWED_LABEL, intakeFixOf, onboardingOf, revertedPrOf } from './github.ts';
import { contractPath, contractShaMatches, isCoreTask, sameArea, taskTier } from './tasks.ts';
import { DISPATCH_MATCH_MINUTES } from './spend.ts';
import type {
  CheckRunSnap,
  ContractSnap,
  Decision,
  DecisionType,
  Effect,
  IssueSnap,
  PlannerEnv,
  Policies,
  PullSnap,
  ReasonCode,
  RepairRunSnap,
  Snapshot,
  TaskHistory,
} from './types.ts';

export const LABEL_READY = 'factory:ready';
export const LABEL_PICKED = 'factory:picked';
export const LABEL_NEEDS_HUMAN = 'needs-human';
/** Every seeded task issue carries this label. */
export const LABEL_TASK = 'factory:task';
/** Hand-off labels: an issue carrying any of them is never auto-readied. */
export const AUTO_READY_HOLDS: readonly string[] = [LABEL_NEEDS_HUMAN, 'stale-contract', 'blocked'];

/**
 * The strict gates (tiers.yaml `auto-strict.strict_gates`) this factory actually enforces:
 * full regression (ci, #71), reviewer agent (controller + gates merge_group), one auto-strict task
 * in flight (#72), auto-revert (#73), semver checks, mutation score, perf and code health (ci). Add a name here only in the PR that
 * implements that gate (a ci gate also goes in github.ts CI_STRICT_GATE_STEPS).
 */
export const IMPLEMENTED_STRICT_GATES: readonly string[] = ['full_regression', 'reviewer_agent', 'serialize_area', 'auto_revert_on_regression', 'semver_checks', 'mutation_score_not_lower', 'perf_regression_max_pct', 'code_health_not_worse'];

/**
 * Listed strict gates that aren't implemented (an unreadable list → one placeholder name). While
 * any remain, removing `start_as: human` doesn't promote anything: auto-strict stays with a person.
 */
export function missingStrictGates(p: Policies): string[] {
  const listed = p.tiers.tiers['auto-strict'].strict_gates;
  if (listed === null) return ['(strict_gates missing or malformed)'];
  return listed.filter((g) => !IMPLEMENTED_STRICT_GATES.includes(g));
}

/** The promotion is in effect: tiers.yaml has no `start_as: human` and every listed strict gate is implemented. */
export function autoStrictPromoted(p: Policies): boolean {
  return p.tiers.tiers['auto-strict'].start_as !== 'human' && missingStrictGates(p).length === 0;
}

/**
 * Tiers that may run without a person: `auto` outside the core paths, and `auto-strict` once
 * the promotion is in effect (`autoStrictPromoted`). Never `human`.
 */
export function autonomousTier(c: ContractSnap, p: Policies): boolean {
  const tier = taskTier(c, p.tiers);
  if (tier === 'auto') return !isCoreTask(c, p.tiers);
  return tier === 'auto-strict' && autoStrictPromoted(p);
}
/** The agent App's login (GraphQL gives `name`, REST `name[bot]`). Only its PRs are auto-merged. */
export const AGENT_LOGIN = 'sabbasi3-factory-agent';

/**
 * The merge stage (DESIGN §7 step 5): a factory PR goes to the merge queue only if every
 * condition holds. Returns the reason it can't (a wait), or null when it can.
 * Never for human, auto-strict or core tasks: those always wait for a person.
 */
export function autoMergeBlocker(pr: PullSnap, c: ContractSnap, issue: IssueSnap | undefined, ci: CheckRunSnap | null, gates: CheckRunSnap | null, p: Policies): string | null {
  if (!mergeTier(c, p)) return 'not_auto_tier';
  if (pr.draft) return 'draft';
  if (!pr.author_is_bot || (pr.author ?? '').replace(/\[bot\]$/, '') !== AGENT_LOGIN) return 'not_agent_pr';
  if (pr.contract_sha !== c.last_commit_sha) return 'contract_sha_not_exact';
  if (!issue || !issue.labels.includes(LABEL_PICKED)) return 'issue_not_picked';
  if (ci?.conclusion !== 'success' || ci.heldout_seed === null) return 'ci_not_green';
  if (gates?.conclusion !== 'success') return 'gates_not_green';
  if (pr.mergeable !== 'MERGEABLE') return 'not_mergeable';
  return null;
}

/**
 * Tiers the merge stage may enqueue: `auto` outside the core paths, and `auto-strict` (which
 * also needs the reviewer agent's pass). `human` never; core paths are `auto-strict` only once
 * the promotion is in effect (no `start_as: human`, every listed strict gate implemented).
 */
export function mergeTier(c: ContractSnap, p: Policies): 'auto' | 'auto-strict' | null {
  const tier = taskTier(c, p.tiers);
  if (tier === 'auto') return isCoreTask(c, p.tiers) ? null : 'auto';
  // Until the promotion PR removes `start_as: human`, and while tiers.yaml lists a strict gate this
  // factory doesn't enforce, no auto-strict task is merged automatically, whether it's auto-strict
  // by its paths or by its contract's own tier.
  if (tier !== 'auto-strict' || !autoStrictPromoted(p)) return null;
  return 'auto-strict';
}

/** Minutes after a review dispatch with no reviewer verdict before a person is asked. */
export const REVIEW_TIMEOUT_MINUTES = 60;

/** ci conclusions after which the reveal step has run, so a held-out seed must exist. */
export const SEED_EXPECTED_CONCLUSIONS = new Set(['success', 'failure']);
/** How long a completed ci run's unreadable seed is waited for before a person looks (missing_heldout_seed). */
export const HELDOUT_PENDING_MINUTES = 30;
/**
 * A cancelled `ci` run on the PR head (the `checks` job hit its time limit, a runner was lost, or
 * someone cancelled it) is final once nothing newer has started for that head within this grace:
 * a person decides at once, instead of the task waiting for `task_timeout` (#457 waited ~24 h).
 */
export const CI_CANCELLED_GRACE_MINUTES = 15;

/** CI conclusions treated as a failure that needs a repair. */
export const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure']);

const EMPTY_HISTORY: TaskHistory = {
  picked_at: null,
  repairs: 0,
  failure_signatures: [],
  repaired_run_ids: [],
  aic_spent: 0,
};

const HOUR_MS = 3_600_000;

interface DecisionInit {
  type: DecisionType;
  reason: ReasonCode;
  effect?: Effect;
  task?: string | null;
  issue?: number | null;
  pr?: number | null;
  attempt?: number | null;
  contract_sha?: string | null;
  run_id?: number | null;
  failure_signature?: string | null;
  source_ids: string[];
}

function decide(d: DecisionInit): Decision {
  return {
    type: d.type,
    reason: d.reason,
    effect: d.effect ?? 'none',
    dry_run: true,
    task: d.task ?? null,
    issue: d.issue ?? null,
    pr: d.pr ?? null,
    attempt: d.attempt ?? null,
    contract_sha: d.contract_sha ?? null,
    run_id: d.run_id ?? null,
    failure_signature: d.failure_signature ?? null,
    source_ids: d.source_ids,
  };
}

/**
 * Whether a PR's changed files are exactly what `harness/onboard/onboard.js add <code>` writes (the
 * same set onboard.yml checks before opening it): new files under the locale's own paths (the module
 * skeleton's .gitkeep files included, parsers/ and refiners/ required), and the two golden indexes modified; nothing else, nothing renamed or removed.
 */
export function onboardingFilesOk(code: string, files: readonly { path: string; status: string }[]): boolean {
  if (!/^[a-z]{2}(?:-[a-z]{4})?$/.test(code)) return false;
  const module = code.replace('-', '_');
  const added = new RegExp(
    `^(src/locales/${module}/(locale\\.json|mod\\.rs|configuration\\.rs|[a-z0-9_]+(/[a-z0-9_]+)*/\\.gitkeep)|tests/golden/${module}/[a-z0-9_]+\\.json|harness/golden/coverage/${module}\\.json|scripts/seed-backlog/taskmap\\.d/${module}\\.yaml|contracts/${code}/[a-z0-9-]+\\.yaml)$`,
  );
  const indexes = ['tests/golden/configurations.json', 'tests/golden/index.json'];
  for (const f of files) {
    if (f.status === 'added' && added.test(f.path)) continue;
    if (f.status === 'modified' && indexes.includes(f.path)) continue;
    return false;
  }
  const has = (status: string, path: string) => files.some((f) => f.status === status && f.path === path);
  return (
    ['locale.json', 'mod.rs', 'configuration.rs', 'parsers/.gitkeep', 'refiners/.gitkeep'].every((f) => has('added', `src/locales/${module}/${f}`)) &&
    has('added', `scripts/seed-backlog/taskmap.d/${module}.yaml`) &&
    indexes.every((p) => has('modified', p)) &&
    files.some((f) => f.status === 'added' && f.path.startsWith(`contracts/${code}/`))
  );
}

/** At most this many pre-triage dispatches per poll (a burst of hand-offs spreads over polls). */
export const MAX_TRIAGES_PER_POLL = 2;
/** Hand-offs older than this aren't pre-triaged (a person has had them for a while). */
export const TRIAGE_MAX_AGE_HOURS = 24;

/**
 * Needs-human hand-offs to pre-triage: this poll's needs_human decisions, and recorded live ones
 * whose task issue still has needs-human and has had no triage since. One per task, oldest
 * first, at most MAX_TRIAGES_PER_POLL. None unless the policy caps the triage agent.
 */
export function triageCandidates(s: Snapshot, p: Policies, decided: readonly Decision[], now: Date): Decision[] {
  if (typeof p.budgets.per_run.needs_human_triage !== 'number') return [];
  const issueOfTask = new Map<string, IssueSnap>();
  for (const i of s.issues) if (i.task_id && i.labels.includes('factory:task')) issueOfTask.set(i.task_id, i);
  const found = new Map<string, { at: string; d: Decision }>();
  const add = (task: string, at: string, init: Omit<DecisionInit, 'type' | 'reason' | 'effect' | 'source_ids'> & { cause: ReasonCode }): void => {
    if (found.has(task) || now.getTime() - Date.parse(at) > TRIAGE_MAX_AGE_HOURS * HOUR_MS) return;
    const h = s.history[task];
    if ((h?.triages ?? []).some((t) => t.at >= at)) return;
    const d = decide({ ...init, type: 'triage_dispatched', reason: 'triage_needed', effect: 'dispatch_workflow:triage', task, source_ids: [`task:${task}`, `handoff:${at}`, `cause:${init.cause}`] });
    found.set(task, { at, d: { ...d, cause: init.cause } });
  };
  const at = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  for (const d of decided) {
    if (d.type !== 'needs_human' || !d.task) continue;
    const issue = d.issue ?? issueOfTask.get(d.task)?.number ?? null;
    if (issue === null) continue;
    add(d.task, at, { cause: d.reason, issue, pr: d.pr, run_id: d.run_id, failure_signature: d.failure_signature });
  }
  for (const [task, h] of Object.entries(s.history)) {
    const nh = h.needs_human;
    const issue = issueOfTask.get(task);
    if (!nh || !issue || !issue.labels.includes(LABEL_NEEDS_HUMAN)) continue;
    add(task, nh.at, { cause: nh.reason as ReasonCode, issue: issue.number, pr: nh.pr, run_id: nh.run_id, failure_signature: nh.failure_signature });
  }
  return [...found.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).slice(0, MAX_TRIAGES_PER_POLL).map((x) => x.d);
}

/**
 * Code scanning on a head, for the merge stage: `pass` (CodeQL's check succeeded); `wait` (no
 * result yet, or still running); `rerun` (every Analyze job finished, one failed and none was re-run
 * yet: GitHub's API rate limit has failed them before, so re-run that Actions run once); `human`
 * (CodeQL found alerts above the ruleset's threshold, or the re-run failed too).
 */
export function codeScanningGate(s: Snapshot, head: string):
  | { kind: 'pass' }
  | { kind: 'wait'; why: string }
  | { kind: 'rerun'; run_id: number }
  | { kind: 'human'; reason: 'code_scanning_alerts' | 'code_scanning_failed'; run_id: number | null } {
  const cs = (s.code_scanning ?? []).find((x) => x.head_sha === head);
  if (!cs) return { kind: 'wait', why: 'code_scanning_unknown' };
  if (cs.codeql?.status === 'completed') {
    if (cs.codeql.conclusion === 'success') return { kind: 'pass' };
    if (cs.codeql.conclusion === 'failure' || cs.codeql.conclusion === 'action_required') return { kind: 'human', reason: 'code_scanning_alerts', run_id: null };
  }
  const done = cs.analyze.length > 0 && cs.analyze.every((a) => a.status === 'completed');
  const failed = cs.analyze.find((a) => a.conclusion !== null && a.conclusion !== 'success' && a.conclusion !== 'skipped' && a.conclusion !== 'neutral');
  if (!done || !failed || cs.codeql?.conclusion === 'success') return { kind: 'wait', why: 'code_scanning_pending' };
  if (failed.run_id === null || failed.run_attempt === null) return { kind: 'human', reason: 'code_scanning_failed', run_id: failed.run_id };
  if (failed.run_attempt <= 1) return { kind: 'rerun', run_id: failed.run_id };
  return { kind: 'human', reason: 'code_scanning_failed', run_id: failed.run_id };
}

function wait(reason: ReasonCode, base: Decision): Decision {
  return { ...base, type: 'wait', reason, effect: 'none' };
}

/** A revert PR the controller opened: its App authored it, from `factory/revert-<n>`. */
export function isControllerRevertPr(pr: PullSnap): boolean {
  return revertedPrOf(pr.head_ref) !== null && pr.author_is_bot && (pr.author ?? '').replace(/\[bot\]$/, '') === CONTROLLER_LOGIN;
}

export function killSwitchEnabled(env: PlannerEnv): boolean {
  // Only the exact string "true" enables dispatch; everything else fails closed.
  return env.FACTORY_ENABLED === 'true';
}

function contractOf(s: Snapshot, task: string): ContractSnap | null {
  return s.contracts[contractPath(task)] ?? null;
}

/** The workflow whose failures Evergreen repairs (build, tests, comparisons). */
export const CI_WORKFLOW = 'ci';
/** The trusted policy gates (scope, Contract-SHA, identifiers): never repaired, a human decides. */
export const GATES_WORKFLOW = 'gates';

/**
 * The newest run of `workflow` for this PR head (highest run_id, then
 * run_attempt), or null if there is none or it hasn't finished yet: a newer
 * run that is still going makes any older result non-actionable.
 * `ci` runs on `pull_request` (head_sha = PR head); `gates` runs on
 * `pull_request_target`, where head_sha is the main tip, so its PR head is
 * `candidate_sha`. merge_group runs are not used for repairs.
 */
export function latestCheck(s: Snapshot, pr: PullSnap, workflow: string): CheckRunSnap | null {
  let best: CheckRunSnap | null = null;
  for (const r of s.check_runs) {
    if (r.workflow !== workflow) continue;
    if (workflow === CI_WORKFLOW && (r.event !== 'pull_request' || r.head_sha !== pr.head_sha)) continue;
    if (workflow === GATES_WORKFLOW && (r.event !== 'pull_request_target' || r.candidate_sha !== pr.head_sha)) continue;
    if (!best || r.run_id > best.run_id || (r.run_id === best.run_id && r.run_attempt > best.run_attempt)) best = r;
  }
  if (!best || best.status !== 'completed' || !best.conclusion) return null;
  return best;
}

/** `latestCheck`, restricted to runs GitHub links to this PR (not another PR at the same commit). */
export function latestCheckOfPr(s: Snapshot, pr: PullSnap, workflow: string): CheckRunSnap | null {
  return latestCheck({ ...s, check_runs: s.check_runs.filter((r) => r.pull_requests.includes(pr.number)) }, pr, workflow);
}

function dependencyDepth(s: Snapshot, task: string, seen: Set<string> = new Set()): number {
  if (seen.has(task)) return Number.POSITIVE_INFINITY; // cycle: sort last
  const c = contractOf(s, task);
  if (!c || c.depends_on.length === 0) return 0;
  seen.add(task);
  let depth = 0;
  for (const dep of c.depends_on) depth = Math.max(depth, 1 + dependencyDepth(s, dep, seen));
  seen.delete(task);
  return depth;
}

/** Tasks whose code is on main: merged factory PRs, minus the ones the controller auto-reverted. */
function mergedTaskPrs(s: Snapshot): {
  mergedTasks: Set<string>;
  mergedPr: Map<string, PullSnap>;
  revertCommitOf: Map<number, string>;
  controllerRevertPrs: PullSnap[];
  revertedPrs: Set<number>;
} {
  const mergedTasks = new Set<string>();
  /** Task → its first merged PR (lowest number), the one that finished it. */
  const mergedPr = new Map<string, PullSnap>();
  // A merged PR the controller auto-reverted no longer counts: its code is gone from main. The
  // ledger is durable: the controller's own revert PRs (open or merged, in any age) plus the
  // recorded `auto_revert` events, so it outlives the audit window.
  const controllerRevertPrs = s.pulls.filter(isControllerRevertPr);
  const revertedPrs = new Set<number>();
  for (const r of controllerRevertPrs) if (r.state !== 'closed') revertedPrs.add(revertedPrOf(r.head_ref)!);
  for (const h of Object.values(s.history)) for (const r of h.reverts ?? []) revertedPrs.add(r.pr);
  const revertCommitOf = new Map<number, string>();
  for (const h of Object.values(s.history)) for (const r of h.reverts ?? []) if (r.revert_pr !== null && r.revert_commit) revertCommitOf.set(r.revert_pr, r.revert_commit);
  for (const pr of [...s.pulls].sort((a, b) => a.number - b.number)) {
    if (pr.state !== 'merged' || !pr.task_id || revertedPrs.has(pr.number)) continue;
    mergedTasks.add(pr.task_id);
    if (!mergedPr.has(pr.task_id)) mergedPr.set(pr.task_id, pr);
  }
  return { mergedTasks, mergedPr, revertCommitOf, controllerRevertPrs, revertedPrs };
}

/**
 * Tasks in flight: an open factory PR, or an open issue picked (label or recorded pick) whose task
 * isn't merged. The WIP limit counts these; the dispatch state reports the same number.
 */
export function inFlightTasks(s: Snapshot): Set<string> {
  const { mergedTasks } = mergedTaskPrs(s);
  const inFlight = new Set<string>();
  for (const pr of s.pulls) if (pr.state === 'open' && pr.task_id) inFlight.add(pr.task_id);
  for (const i of s.issues) {
    if (!i.task_id || mergedTasks.has(i.task_id)) continue;
    if (i.labels.includes(LABEL_PICKED) || s.history[i.task_id]?.picked_at) inFlight.add(i.task_id);
  }
  return inFlight;
}

/**
 * The finished repair run for a failing CI run at `head`: matched to the controller's own
 * `repair_dispatched` record (same task, issue and attempt, created within DISPATCH_MATCH_MINUTES
 * after it), not to the run name alone. Null while it runs, or when it can't be found or listed
 * (the task's wall-clock limit is the backstop).
 */
export function finishedRepair(s: Snapshot, task: string, failedRun: number, head: string, h: TaskHistory): RepairRunSnap | null {
  if (!s.repair_runs) return null;
  const rec = (h.repair_dispatches ?? []).filter((d) => d.run_id === failedRun && d.head === head).sort((a, b) => b.at.localeCompare(a.at))[0];
  if (!rec) return null;
  return finishedRun(s.repair_runs, `Repair ${task} #${rec.issue} attempt ${rec.attempt}`, rec.at);
}

/** The newest run with this exact name created within DISPATCH_MATCH_MINUTES after `at`, if completed. */
function finishedRun(runs: readonly RepairRunSnap[], title: string, at: string): RepairRunSnap | null {
  const t = Date.parse(at);
  const run = runs
    .filter((r) => r.display_title === title && Date.parse(r.created_at) >= t && Date.parse(r.created_at) - t <= DISPATCH_MATCH_MINUTES * 60_000)
    .sort((a, b) => b.id - a.id)[0];
  return run && run.status === 'completed' ? run : null;
}

/**
 * The finished implement run for a task's current attempt that opened no PR: matched to the
 * controller's own `dispatched` record (task, issue, attempt; created within DISPATCH_MATCH_MINUTES
 * after it), with no agent PR for the task opened since that dispatch. Null while it runs, once a PR
 * exists, or when the runs can't be listed or matched (the task's wall-clock limit is the backstop).
 */
export function finishedImplementWithoutPr(s: Snapshot, task: string, h: TaskHistory): RepairRunSnap | null {
  if (!s.implement_runs || !h.picked_at) return null;
  const rec = (h.implement_dispatches ?? []).filter((d) => d.at >= h.picked_at!).sort((a, b) => b.at.localeCompare(a.at))[0];
  if (!rec) return null;
  const run = finishedRun(s.implement_runs, `Implement ${task} #${rec.issue} attempt ${rec.attempt}`, rec.at);
  if (!run) return null;
  const agentPr = s.pulls.some((pr) => pr.task_id === task && pr.author_is_bot && (pr.author ?? '').replace(/\[bot\]$/, '') === AGENT_LOGIN && pr.created_at >= rec.at);
  return agentPr ? null : run;
}

/** The implement run for the dispatch recorded at or after `from` (and before `until`) finished without an agent PR. */
function implementRunEndedWithoutPr(s: Snapshot, task: string, h: TaskHistory, from: string, until: string): boolean {
  if (!s.implement_runs) return false;
  const rec = (h.implement_dispatches ?? []).filter((d) => d.at >= from && d.at <= until).sort((a, b) => b.at.localeCompare(a.at))[0];
  if (!rec) return false;
  const run = finishedRun(s.implement_runs, `Implement ${task} #${rec.issue} attempt ${rec.attempt}`, rec.at);
  if (!run || Date.parse(run.created_at) > Date.parse(until)) return false;
  return !s.pulls.some((pr) => pr.task_id === task && pr.author_is_bot && (pr.author ?? '').replace(/\[bot\]$/, '') === AGENT_LOGIN && pr.created_at >= rec.at);
}

/**
 * A task issue reopened after its attempt ended is a fresh start. "Ended" means the agent's factory
 * PR for the task, opened after that pick, was closed unmerged before the reopen, or that attempt's
 * implement run finished without opening a PR. A close and reopen while the attempt is still
 * running (no PR yet) changes nothing. Then picks before the reopen no longer make
 * the task "in flight", and a `factory:picked` label left from before is stale. Mutates `s`: the
 * task's `picked_at` becomes its first pick after the reopen (or null), `reset_at` records the reopen
 * (the re-dispatch's audit identity), and the stale label is dropped from the snapshot (the next
 * dispatch adds it again). Returns the tasks reset. An unknown reopen time changes nothing (fail closed).
 */
export function applyReopens(s: Snapshot): string[] {
  const reset: string[] = [];
  for (const i of s.issues) {
    const task = i.task_id;
    const at = i.reopened_at;
    if (!task || !at) continue;
    // A reopen at or after this poll's own time waits a poll: this poll's records carry that time, so
    // a re-dispatch made now must come strictly after the reopen it follows.
    if (at >= s.fetched_at) continue;
    // An open factory PR still holds the task, whatever the reopen.
    if (s.pulls.some((pr) => pr.task_id === task && pr.state === 'open')) continue;
    const h = s.history[task];
    if (!h?.picked_at || h.picked_at > at) continue;
    const before = (h.picks ?? [h.picked_at]).filter((t) => t <= at).sort();
    const lastPick = before[before.length - 1] ?? h.picked_at;
    const prClosed = s.pulls.some(
      (pr) => pr.task_id === task && pr.state === 'closed' && pr.author_is_bot && (pr.author ?? '').replace(/\[bot\]$/, '') === AGENT_LOGIN && pr.created_at >= lastPick && pr.created_at <= at,
    );
    // Or that attempt's implement run finished without opening a PR (implement_no_pr / implement_failed).
    const ended = prClosed || implementRunEndedWithoutPr(s, task, h, lastPick, at);
    if (!ended) continue;
    const after = (h.picks ?? []).filter((t) => t > at).sort();
    s.history[task] = { ...h, picked_at: after[0] ?? null, reset_at: at };
    if (after.length === 0) i.labels = i.labels.filter((l) => l !== LABEL_PICKED);
    reset.push(task);
  }
  return reset;
}

export function plan(s: Snapshot, p: Policies, env: PlannerEnv, now: Date): Decision[] {
  const out: Decision[] = [];
  const day = now.toISOString().slice(0, 10);
  const nowMs = now.getTime();

  const { mergedTasks, mergedPr, revertCommitOf, controllerRevertPrs, revertedPrs } = mergedTaskPrs(s);
  const openPulls = s.pulls.filter((pr) => pr.state === 'open').sort((a, b) => a.number - b.number);
  const openIssues = [...s.issues].sort((a, b) => a.number - b.number);
  const issueByTask = new Map<string, IssueSnap>();
  for (const i of openIssues) if (i.task_id && !issueByTask.has(i.task_id)) issueByTask.set(i.task_id, i);
  const history = (task: string): TaskHistory => s.history[task] ?? EMPTY_HISTORY;

  // ---- budget (factory per day)
  const max = p.budgets.factory_per_day.max_aic;
  let budget: 'ok' | 'alert' | 'paused' | 'unknown' = 'unknown';
  if (s.factory_aic_today !== null && Number.isFinite(s.factory_aic_today) && s.factory_aic_today >= 0) {
    const pct = (s.factory_aic_today / max) * 100;
    budget = pct >= p.budgets.factory_per_day.pause_at_pct ? 'paused' : pct >= p.budgets.factory_per_day.alert_at_pct ? 'alert' : 'ok';
  }
  if (budget === 'paused') {
    out.push(decide({ type: 'budget_pause', reason: 'budget_pause', effect: 'pause_dispatch', source_ids: [`day:${day}`] }));
  } else if (budget === 'alert') {
    out.push(decide({ type: 'budget_alert', reason: 'budget_alert', effect: 'alert:owner', source_ids: [`day:${day}`] }));
  }

  // ---- tasks in flight
  const inFlight = inFlightTasks(s);

  // ---- human review queue: needs-human issues/PRs + open human-tier factory PRs
  const humanQueue = new Set<string>();
  for (const i of openIssues) if (i.labels.includes(LABEL_NEEDS_HUMAN)) humanQueue.add(i.node_id);
  for (const pr of openPulls) {
    if (pr.labels.includes(LABEL_NEEDS_HUMAN)) humanQueue.add(pr.node_id);
    else if (!pr.draft && pr.task_id) {
      const c = contractOf(s, pr.task_id);
      if (!c || taskTier(c, p.tiers) === 'human') humanQueue.add(pr.node_id);
    }
  }

  // Candidates for dispatch (repairs first, then new tasks), gated below.
  const repairs: Decision[] = [];
  // Merge-queue candidates: gated by the kill switch only (merging spends no AI credits).
  const merges: Decision[] = [];
  // Reviewer-agent dispatches: they spend AI credits, so they pass the same gates as repairs.
  const reviews: Decision[] = [];

  // ---- post-merge regression on main (ci on push to main). The newest finished run per commit.
  const mainRuns = new Map<string, CheckRunSnap>();
  for (const r of s.check_runs) {
    if (r.workflow !== CI_WORKFLOW || r.event !== 'push' || r.status !== 'completed' || !r.conclusion) continue;
    const prev = mainRuns.get(r.head_sha);
    if (!prev || r.run_id > prev.run_id || (r.run_id === prev.run_id && r.run_attempt > prev.run_attempt)) mainRuns.set(r.head_sha, r);
  }
  // Earlier auto-reverts a person hasn't marked reviewed: while any exists, the controller never
  // reverts again by itself. Reviewed = the revert PR has `factory:revert-reviewed`, added by a
  // person (timeline: a non-bot actor), not by any App. Recorded reverts without a PR count too.
  const pullByNumber = new Map(s.pulls.map((x) => [x.number, x]));
  const reviewedByPerson = (x: PullSnap | undefined): boolean =>
    !!x && x.labels.includes(REVERT_REVIEWED_LABEL) && (x.labeled_events ?? []).some((e) => e.label === REVERT_REVIEWED_LABEL && !e.actor_is_bot && e.actor !== null);
  const unreviewedReverts = [
    ...controllerRevertPrs.filter((r) => !reviewedByPerson(r)).map((r) => r.number),
    ...Object.values(s.history).flatMap((h) => h.reverts ?? []).filter((r) => r.revert_pr === null || !reviewedByPerson(pullByNumber.get(r.revert_pr))).map((r) => r.revert_pr ?? -1),
  ];
  const reverts: Decision[] = [];
  for (const pr of [...s.pulls].sort((a, b) => a.number - b.number)) {
    if (pr.state !== 'merged' || !pr.merge_commit_sha) continue;
    const run = mainRuns.get(pr.merge_commit_sha);
    if (!run || !FAILED_CONCLUSIONS.has(run.conclusion!)) continue;
    if (revertedPrs.has(pr.number)) continue; // already reverted
    // Only auto-strict merges the controller made (that exact head), and its own revert PRs, are
    // watched here. Every other merge is a person's to watch (no hand-off: dormant until promotion).
    const task = pr.task_id;
    const c = task ? contractOf(s, task) : null;
    const ours = task !== null && (history(task).enqueued ?? []).some((e) => e.pr === pr.number && e.head === pr.head_sha);
    const strictOurs = !!c && mergeTier(c, p) === 'auto-strict' && ours;
    const isRevert = isControllerRevertPr(pr);
    if (!strictOurs && !isRevert) continue;
    const base = { task, pr: pr.number, run_id: run.run_id };
    // Confirm first: one failure may be flaky. Re-run the check once; only a second failed
    // attempt with the same trusted signature is a regression.
    if (run.run_attempt < 2) {
      reverts.push(decide({ ...base, type: 'main_ci_rerun', reason: 'confirm_regression', effect: 'rerun_ci', source_ids: [`${run.run_id}/attempts/${run.run_attempt}`, 'rerun'] }));
      continue;
    }
    const confirmed = run.failure_signature !== null && run.failure_signature === run.first_attempt_signature;
    const runId = `${run.run_id}/attempts/${run.run_attempt}`;
    // A person is told on the merged PR, once (label + comment).
    out.push(decide({ ...base, type: 'needs_human', reason: 'main_regressed', effect: 'label:needs-human', source_ids: [pr.node_id, 'main_regressed'] }));
    if (!confirmed || isRevert) continue; // different signatures, or a revert that broke main: a person decides
    if (unreviewedReverts.length > 0) {
      out.push(decide({ ...base, type: 'needs_human', reason: 'revert_limit', effect: 'none', source_ids: [runId, pr.node_id, 'revert_limit'] }));
      continue;
    }
    // Only a revert of main's tip is mechanical (the parent's tree); anything merged since needs a person.
    if (s.main_sha !== pr.merge_commit_sha) {
      out.push(decide({ ...base, type: 'needs_human', reason: 'revert_not_safe', effect: 'none', source_ids: [runId, pr.node_id, `main:${s.main_sha ?? 'unknown'}`] }));
      continue;
    }
    reverts.push({ ...decide({ ...base, type: 'auto_revert', reason: 'main_regressed', effect: 'open_revert', source_ids: [pr.node_id, pr.merge_commit_sha, 'revert'] }), merge_commit_sha: pr.merge_commit_sha });
    // Same poll: the task no longer counts as merged (no dependent is admitted, no task_done),
    // unless another merged, unreverted PR delivers it.
    if (task) {
      revertedPrs.add(pr.number);
      const other = s.pulls.find((x) => x.state === 'merged' && x.task_id === task && !revertedPrs.has(x.number));
      if (other) mergedPr.set(task, other);
      else {
        mergedTasks.delete(task);
        mergedPr.delete(task);
      }
    }
  }

  // ---- task done: an open task issue whose task has a merged PR leaves the pipeline (close the
  // issue as completed, remove factory:ready/factory:picked). Gated by the kill switch only (no
  // escalation can hold it back). It keeps being planned while the issue is open, so an
  // interrupted close is finished next poll.
  const dones: Decision[] = [];
  for (const i of openIssues) {
    if (i.marker_status !== 'ok' || !i.task_id) continue;
    const done = mergedPr.get(i.task_id);
    if (!done) continue;
    dones.push(decide({ type: 'task_done', reason: 'task_merged', effect: 'close_task', task: i.task_id, issue: i.number, pr: done.number, source_ids: [i.node_id, done.node_id] }));
  }

  // Tasks escalated to needs_human in this run get no other decision (at most
  // one terminal decision per task per run). Timeouts are evaluated first.
  const escalated = new Set<string>();
  const escalate = (d: Decision): void => {
    if (d.task) escalated.add(d.task);
    out.push(d);
  };

  // ---- task time limit (picked → merged within max_wall_clock_hours)
  const limitMs = p.limits.task.max_wall_clock_hours * HOUR_MS;
  for (const task of [...inFlight].sort()) {
    const h = history(task);
    if (!h.picked_at || mergedTasks.has(task)) continue;
    const pickedMs = Date.parse(h.picked_at);
    if (!Number.isFinite(pickedMs) || nowMs - pickedMs <= limitMs) continue;
    const issue = issueByTask.get(task);
    const pr = openPulls.find((x) => x.task_id === task);
    if (issue?.labels.includes(LABEL_NEEDS_HUMAN) || pr?.labels.includes(LABEL_NEEDS_HUMAN)) continue;
    const subject = issue?.node_id ?? pr?.node_id;
    if (!subject) continue;
    escalated.add(task);
    out.push(decide({ type: 'needs_human', reason: 'task_timeout', effect: 'label:needs-human', task, issue: issue?.number ?? null, pr: pr?.number ?? null, source_ids: [subject, `picked:${h.picked_at}`] }));
  }

  // ---- implement ended without a PR (tightening, like repair_no_push): the current attempt's run
  // finished and no agent PR exists → a person, at once (never re-dispatched; the time limit stays).
  for (const i of openIssues) {
    const task = i.task_id;
    if (!task || mergedTasks.has(task) || escalated.has(task) || i.labels.includes(LABEL_NEEDS_HUMAN)) continue;
    // Only the agent's own PR for this attempt counts (finishedImplementWithoutPr filters by author
    // and time): a person's PR, or an agent PR from an earlier attempt, doesn't stop the hand-off.
    if (!inFlight.has(task)) continue;
    const run = finishedImplementWithoutPr(s, task, history(task));
    if (!run) continue;
    escalated.add(task);
    out.push(decide({
      type: 'needs_human', reason: run.conclusion === 'success' ? 'implement_no_pr' : 'implement_failed', effect: 'label:needs-human',
      task, issue: i.number, pr: null, run_id: run.id, source_ids: [i.node_id, `implement_run:${run.id}`],
    }));
  }

  // A picked issue whose pick time isn't in the history window can never time
  // out: fail closed and hand it to a human instead of letting it run forever.
  for (const i of openIssues) {
    const task = i.task_id;
    if (!task || !i.labels.includes(LABEL_PICKED) || i.labels.includes(LABEL_NEEDS_HUMAN)) continue;
    if (mergedTasks.has(task) || escalated.has(task) || history(task).picked_at) continue;
    const pr = openPulls.find((x) => x.task_id === task);
    if (pr?.labels.includes(LABEL_NEEDS_HUMAN)) continue;
    escalate(decide({ type: 'needs_human', reason: 'pick_time_unknown', effect: 'label:needs-human', task, issue: i.number, pr: pr?.number ?? null, source_ids: [i.node_id, 'picked:unknown'] }));
  }
  const unchecked = new Set(s.unchecked_heads);

  // ---- the controller's revert PRs: enqueued once their own ci and gates pass (no task, no
  // review), and only while their head is still exactly the recorded revert commit.
  for (const pr of openPulls) {
    if (!isControllerRevertPr(pr)) continue;
    if (pr.labels.includes(LABEL_NEEDS_HUMAN) || pr.in_merge_queue || unchecked.has(pr.head_sha)) continue;
    const base = { task: null, pr: pr.number, issue: null };
    if (revertCommitOf.get(pr.number) !== pr.head_sha) {
      // Someone pushed to the revert branch (or the record is gone): not a mechanical revert any more.
      out.push(decide({ ...base, type: 'needs_human', reason: 'revert_head_changed', effect: 'label:needs-human', source_ids: [pr.node_id, pr.head_sha] }));
      continue;
    }
    const removed = pr.merge_queue_events.find((e) => e.kind === 'dequeued' && (e.reason ?? '').toLowerCase() !== 'merged');
    if (removed) {
      out.push(decide({ ...base, type: 'needs_human', reason: 'merge_queue_rejected', effect: 'label:needs-human', source_ids: [pr.node_id, removed.node_id] }));
      continue;
    }
    const ci = latestCheck(s, pr, CI_WORKFLOW);
    const gates = latestCheck(s, pr, GATES_WORKFLOW);
    const failed = [ci, gates].find((r) => r?.conclusion && FAILED_CONCLUSIONS.has(r.conclusion));
    if (failed) {
      out.push(decide({ ...base, type: 'needs_human', reason: 'revert_checks_failed', effect: 'label:needs-human', run_id: failed.run_id, source_ids: [`${failed.run_id}/attempts/${failed.run_attempt}`, pr.node_id] }));
      continue;
    }
    if (ci?.conclusion !== 'success' || gates?.conclusion !== 'success' || pr.mergeable !== 'MERGEABLE') continue;
    merges.push({ ...decide({ ...base, type: 'auto_merge', reason: 'revert_ready', effect: 'enqueue_merge', run_id: ci.run_id, source_ids: [pr.node_id, pr.head_sha] }), head_sha: pr.head_sha });
  }

  // ---- bug-intake fix PRs (harness/feedback, tiers.yaml intake_fixes): a new fix case and its
  // contract, from the controller App's intake. Queued without the owner only if the policy allows
  // it, the PR only ADDS exactly those three files for its own fix id, ci (which regenerates the case
  // through the pinned chrono-node and checks the contract against the seed script) and gates are
  // green, and fewer than max_per_day intake fixes merged or were queued today (UTC). Otherwise the
  // owner decides (needs-human), as for every other human-tier PR.
  const intake = p.tiers.intake_fixes;
  const today = now.toISOString().slice(0, 10);
  let intakeToday = s.pulls.filter((x) => intakeFixOf(x) !== null && ((x.merged_at ?? '').startsWith(today) || (x.state === 'open' && x.in_merge_queue))).length;
  for (const pr of openPulls) {
    const fix = intakeFixOf(pr);
    if (fix === null || !intake?.auto_merge || pr.draft) continue;
    if (pr.labels.includes(LABEL_NEEDS_HUMAN) || pr.in_merge_queue || unchecked.has(pr.head_sha) || pr.files == null) continue;
    const base = { task: null, pr: pr.number, issue: null };
    const removed = pr.merge_queue_events.find((e) => e.kind === 'dequeued' && (e.reason ?? '').toLowerCase() !== 'merged');
    if (removed) {
      out.push(decide({ ...base, type: 'needs_human', reason: 'merge_queue_rejected', effect: 'label:needs-human', source_ids: [pr.node_id, removed.node_id] }));
      continue;
    }
    const [lang, hash] = fix.split('/fix-') as [string, string];
    const want = [`contracts/${fix}.yaml`, `harness/golden/fixes/${lang}-fix-${hash}.json`, `tests/golden/fixes/${lang}-fix-${hash}.json`];
    const got = pr.files.map((f) => `${f.status}:${f.path}`).sort();
    if (got.join('|') !== want.map((w) => `added:${w}`).sort().join('|')) {
      out.push(decide({ ...base, type: 'needs_human', reason: 'intake_fix_not_additive', effect: 'label:needs-human', source_ids: [pr.node_id, pr.head_sha] }));
      continue;
    }
    const ci = latestCheckOfPr(s, pr, CI_WORKFLOW);
    const gates = latestCheckOfPr(s, pr, GATES_WORKFLOW);
    const failed = [ci, gates].find((r) => r?.conclusion && FAILED_CONCLUSIONS.has(r.conclusion));
    if (failed) {
      out.push(decide({ ...base, type: 'needs_human', reason: 'intake_fix_checks_failed', effect: 'label:needs-human', run_id: failed.run_id, source_ids: [`${failed.run_id}/attempts/${failed.run_attempt}`, pr.node_id] }));
      continue;
    }
    if (ci?.conclusion !== 'success' || gates?.conclusion !== 'success' || pr.mergeable !== 'MERGEABLE') continue;
    // With the kill switch off nothing is enqueued, so no slot is taken and no cap hand-off is made:
    // the enqueue below just waits on the kill switch.
    if (killSwitchEnabled(env)) {
      if (intakeToday >= intake.max_per_day) {
        out.push(decide({ ...base, type: 'needs_human', reason: 'intake_fix_daily_cap', effect: 'label:needs-human', source_ids: [pr.node_id, `day:${today}`] }));
        continue;
      }
      intakeToday++;
    }
    merges.push({ ...decide({ ...base, type: 'auto_merge', reason: 'intake_fix_ready', effect: 'enqueue_merge', run_id: ci.run_id, source_ids: [pr.node_id, pr.head_sha] }), head_sha: pr.head_sha });
  }

  // ---- generated language-onboarding PRs (harness/onboard, tiers.yaml onboarding): the generator's
  // output for one locale, from the controller App's onboard.yml. Queued without the owner only if
  // the policy allows it, the PR is exactly generator output for its own code (onboardingFilesOk),
  // ci (which regenerates every file byte for byte: golden:check, onboard.js check, seed.js
  // contracts --check) and gates are green, and fewer than max_per_day onboarding PRs merged or were
  // queued today (UTC). Otherwise the owner decides (needs-human).
  const onboarding = p.tiers.onboarding;
  let onboardedToday = s.pulls.filter((x) => onboardingOf(x) !== null && ((x.merged_at ?? '').startsWith(today) || (x.state === 'open' && x.in_merge_queue))).length;
  for (const pr of openPulls) {
    const code = onboardingOf(pr);
    if (code === null || !onboarding?.auto_merge || pr.draft) continue;
    if (pr.labels.includes(LABEL_NEEDS_HUMAN) || pr.in_merge_queue || unchecked.has(pr.head_sha) || pr.files == null) continue;
    const base = { task: null, pr: pr.number, issue: null };
    const removed = pr.merge_queue_events.find((e) => e.kind === 'dequeued' && (e.reason ?? '').toLowerCase() !== 'merged');
    if (removed) {
      out.push(decide({ ...base, type: 'needs_human', reason: 'merge_queue_rejected', effect: 'label:needs-human', source_ids: [pr.node_id, removed.node_id] }));
      continue;
    }
    if (!onboardingFilesOk(code, pr.files)) {
      out.push(decide({ ...base, type: 'needs_human', reason: 'onboarding_not_generated', effect: 'label:needs-human', source_ids: [pr.node_id, pr.head_sha] }));
      continue;
    }
    // This PR's own runs only: ci's `seed.js contracts --check` step runs only on factory/onboard/*
    // branches, so a green run of another PR at the same commit doesn't count.
    const ci = latestCheckOfPr(s, pr, CI_WORKFLOW);
    const gates = latestCheckOfPr(s, pr, GATES_WORKFLOW);
    const failed = [ci, gates].find((r) => r?.conclusion && FAILED_CONCLUSIONS.has(r.conclusion));
    if (failed) {
      out.push(decide({ ...base, type: 'needs_human', reason: 'onboarding_checks_failed', effect: 'label:needs-human', run_id: failed.run_id, source_ids: [`${failed.run_id}/attempts/${failed.run_attempt}`, pr.node_id] }));
      continue;
    }
    if (ci?.conclusion !== 'success' || gates?.conclusion !== 'success' || pr.mergeable !== 'MERGEABLE') continue;
    // With the kill switch off nothing is enqueued, so no slot is taken and no cap hand-off is made:
    // the enqueue below just waits on the kill switch.
    if (killSwitchEnabled(env)) {
      if (onboardedToday >= onboarding.max_per_day) {
        out.push(decide({ ...base, type: 'needs_human', reason: 'onboarding_daily_cap', effect: 'label:needs-human', source_ids: [pr.node_id, `day:${today}`] }));
        continue;
      }
      onboardedToday++;
    }
    merges.push({ ...decide({ ...base, type: 'auto_merge', reason: 'onboarding_ready', effect: 'enqueue_merge', run_id: ci.run_id, source_ids: [pr.node_id, pr.head_sha] }), head_sha: pr.head_sha });
  }

  // ---- open factory PRs: contract freshness and CI failures
  for (const pr of openPulls) {
    if (!pr.task_id || pr.labels.includes(LABEL_NEEDS_HUMAN) || escalated.has(pr.task_id)) continue;
    // The task is already done (another PR merged): a leftover open PR gets no repair, hand-off or merge.
    if (mergedTasks.has(pr.task_id)) continue;
    // Handed to a human on either side (the issue or the PR): no repair or contract decision.
    if (issueByTask.get(pr.task_id)?.labels.includes(LABEL_NEEDS_HUMAN)) continue;
    const task = pr.task_id;
    const base = { task, pr: pr.number, issue: issueByTask.get(task)?.number ?? null };
    const c = contractOf(s, task);
    if (!c) {
      out.push(decide({ ...base, type: 'stale_contract', reason: 'contract_missing', effect: 'label:stale-contract', source_ids: [pr.node_id, pr.head_sha] }));
      continue;
    }
    if (!c.valid) {
      out.push(decide({ ...base, type: 'blocked', reason: 'invalid_contract', effect: 'label:blocked', contract_sha: c.last_commit_sha, source_ids: [pr.node_id, c.last_commit_sha] }));
      continue;
    }
    if (!pr.contract_sha) {
      out.push(decide({ ...base, type: 'blocked', reason: 'missing_contract_sha', effect: 'label:blocked', source_ids: [pr.node_id, pr.head_sha] }));
      continue;
    }
    if (!contractShaMatches(pr.contract_sha, c.last_commit_sha)) {
      out.push(decide({ ...base, type: 'stale_contract', reason: 'contract_changed', effect: 'label:stale-contract', contract_sha: c.last_commit_sha, source_ids: [pr.node_id, pr.head_sha, c.last_commit_sha] }));
      continue;
    }
    // Runs for this head weren't looked up (too many open PRs): the newest run may be missing.
    if (unchecked.has(pr.head_sha)) {
      out.push(decide({ ...base, type: 'wait', reason: 'check_runs_incomplete', source_ids: [pr.node_id, pr.head_sha] }));
      continue;
    }
    // A failed policy gate is not something Evergreen can repair: a human decides.
    const gates = latestCheck(s, pr, GATES_WORKFLOW);
    if (gates?.conclusion && FAILED_CONCLUSIONS.has(gates.conclusion)) {
      escalate(decide({ ...base, type: 'needs_human', reason: 'gates_failed', effect: 'label:needs-human', run_id: gates.run_id, contract_sha: c.last_commit_sha, source_ids: [`${gates.run_id}/attempts/${gates.run_attempt}`, pr.node_id] }));
      continue;
    }
    const run = latestCheck(s, pr, CI_WORKFLOW);
    // Every finished ci run (pass or fail) must carry a held-out seed from the trusted
    // commit–reveal. None means the commitment was missing, forged, ambiguous or unrevealed, or
    // the change touched `.github/`: a human looks, whatever the result (fail closed).
    // Unreadable this poll (an API that didn't answer, not a bad commitment): wait, read again next
    // poll, and escalate only if it stays unreadable (one transient read escalated #253).
    if (run?.heldout_pending && SEED_EXPECTED_CONCLUSIONS.has(run.conclusion ?? '') && nowMs - Date.parse(run.updated_at) < HELDOUT_PENDING_MINUTES * 60_000) {
      out.push(decide({ ...base, type: 'wait', reason: 'heldout_seed_pending', source_ids: [`${run.run_id}/attempts/${run.run_attempt}`, pr.node_id] }));
      continue;
    }
    if (run && run.heldout_seed === null && SEED_EXPECTED_CONCLUSIONS.has(run.conclusion ?? '')) {
      escalate(decide({ ...base, type: 'needs_human', reason: 'missing_heldout_seed', effect: 'label:needs-human', run_id: run.run_id, contract_sha: c.last_commit_sha, source_ids: [`${run.run_id}/attempts/${run.run_attempt}`, pr.node_id] }));
      continue;
    }
    // ---- merge stage: green auto-tier agent PRs go to the merge queue (live), nothing else does.
    if (run?.conclusion === 'success' && gates?.conclusion === 'success' && mergeTier(c, p) !== null) {
      if (pr.in_merge_queue) continue;
      const issue = issueByTask.get(task);
      // Queue history. GitHub's removal events don't say which head was queued, so each of the
      // controller's own enqueues (recorded with its head) claims the first removal after it.
      // Removals no controller enqueue claims came from someone else's queue entry.
      const removals = pr.merge_queue_events
        .filter((e) => e.kind === 'dequeued' && (e.reason ?? '').toLowerCase() !== 'merged')
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
      const ours = (history(task).enqueued ?? []).filter((e) => e.pr === pr.number).sort((a, b) => a.at.localeCompare(b.at));
      const claimed = new Map<string, (typeof removals)[number]>();
      const used = new Set<string>();
      for (const e of ours) {
        const r = removals.find((x) => !used.has(x.node_id) && x.created_at > e.at);
        if (r) {
          used.add(r.node_id);
          claimed.set(`${e.head}@${e.at}`, r);
        }
      }
      const mine = ours.filter((e) => e.head === pr.head_sha);
      const rejectedMine = mine.map((e) => claimed.get(`${e.head}@${e.at}`)).find((r) => r !== undefined);
      const foreign = removals.filter((r) => !used.has(r.node_id));
      // Our enqueue of this head left the queue unmerged, or someone else's queue entry was
      // removed and we never queued this head: a person decides. Never re-queued automatically.
      const rejected = rejectedMine ?? (mine.length === 0 ? foreign.at(-1) : undefined);
      if (rejected) {
        escalate(decide({ ...base, type: 'needs_human', reason: 'merge_queue_rejected', effect: 'label:needs-human', run_id: run.run_id, contract_sha: c.last_commit_sha, source_ids: [pr.node_id, rejected.node_id] }));
        continue;
      }
      if (mine.length > 0) continue; // this head is already queued (or merging)
      const blocker = autoMergeBlocker(pr, c, issue, run, gates, p);
      const merge: Decision = { ...decide({ ...base, type: 'auto_merge', reason: 'auto_merge_ready', effect: 'enqueue_merge', run_id: run.run_id, contract_sha: c.last_commit_sha, source_ids: [pr.node_id, pr.head_sha] }), head_sha: pr.head_sha };
      if (blocker !== null) {
        out.push({ ...wait('merge_not_ready', merge), source_ids: [pr.node_id, pr.head_sha, `blocker:${blocker}`] });
        continue;
      }
      // ---- code scanning (limits.ci.wait_for_code_scanning): the main ruleset's code-scanning rule
      // refuses an enqueue until CodeQL has passed on the head, so wait for it here instead of
      // turning a slow analysis into merge_queue_rejected.
      if (p.limits.ci.wait_for_code_scanning) {
        const cs = codeScanningGate(s, pr.head_sha);
        if (cs.kind === 'wait') {
          out.push({ ...wait('merge_not_ready', merge), source_ids: [pr.node_id, pr.head_sha, `blocker:${cs.why}`] });
          continue;
        }
        if (cs.kind === 'rerun') {
          reverts.push(decide({ ...base, type: 'code_scanning_rerun', reason: 'code_scanning_failed', effect: 'rerun_ci', run_id: cs.run_id, source_ids: [`${cs.run_id}/attempts/1`, pr.head_sha, 'code-scanning-rerun'] }));
          continue;
        }
        if (cs.kind === 'human') {
          escalate(decide({ ...base, type: 'needs_human', reason: cs.reason, effect: 'label:needs-human', run_id: cs.run_id, contract_sha: c.last_commit_sha, source_ids: [pr.node_id, pr.head_sha, `code-scanning:${cs.reason}`] }));
          continue;
        }
      }
      // ---- reviewer agent (auto-strict only): a pass from the reviewer App on this exact head,
      // posted after the controller asked for it, is required. Anything else fails closed.
      if (mergeTier(c, p) === 'auto-strict') {
        // Full regression first (DESIGN §9 strict gates): the `checks` job's auto-strict step
        // must have succeeded on this head. The run is finished, so a skipped or missing step
        // won't change: a person decides (never a review or a merge without it).
        if (run.full_regression !== 'success') {
          escalate(decide({ ...base, type: 'needs_human', reason: 'full_regression_missing', effect: 'label:needs-human', run_id: run.run_id, contract_sha: c.last_commit_sha, source_ids: [`${run.run_id}/attempts/${run.run_attempt}`, pr.node_id, 'full_regression'] }));
          continue;
        }
        const forHead = (history(task).reviews ?? []).filter((r) => r.pr === pr.number && r.head === pr.head_sha).sort((a, b) => a.at.localeCompare(b.at));
        const asked = forHead.filter((r) => r.contract === c.last_commit_sha);
        // A review of this head against another (or an unknown) contract never counts, and a second
        // paid review of the same head isn't sent automatically: a person decides.
        if (asked.length === 0 && forHead.length > 0) {
          escalate(decide({ ...base, type: 'needs_human', reason: 'review_contract_changed', effect: 'label:needs-human', run_id: run.run_id, contract_sha: c.last_commit_sha, source_ids: [pr.node_id, pr.head_sha, `contract:${c.last_commit_sha}`] }));
          continue;
        }
        const since = asked[0]?.at;
        if (!since) {
          reviews.push({ ...decide({ ...base, type: 'review_dispatched', reason: 'review_needed', effect: 'dispatch_workflow:review', run_id: run.run_id, contract_sha: c.last_commit_sha, source_ids: [pr.node_id, pr.head_sha, 'review'] }), head_sha: pr.head_sha });
          continue;
        }
        const verdict = (s.review_checks ?? [])
          // A verdict counts only if it started within the review window after the dispatch.
          .filter((k) => k.head_sha === pr.head_sha && k.reviewed_head === pr.head_sha && k.started_at >= since && Date.parse(k.started_at) <= Date.parse(since) + REVIEW_TIMEOUT_MINUTES * 60_000)
          .sort((a, b) => b.id - a.id)[0];
        if (verdict && verdict.status === 'completed') {
          if (verdict.conclusion !== 'success') {
            escalate(decide({ ...base, type: 'needs_human', reason: 'review_objected', effect: 'label:needs-human', run_id: run.run_id, contract_sha: c.last_commit_sha, source_ids: [pr.node_id, pr.head_sha, `check:${verdict.id}`] }));
            continue;
          }
        } else if (nowMs - Date.parse(since) > REVIEW_TIMEOUT_MINUTES * 60_000) {
          escalate(decide({ ...base, type: 'needs_human', reason: 'review_timeout', effect: 'label:needs-human', run_id: run.run_id, contract_sha: c.last_commit_sha, source_ids: [pr.node_id, pr.head_sha, `review:${since}`] }));
          continue;
        } else {
          out.push({ ...wait('review_pending', merge), source_ids: [pr.node_id, pr.head_sha, `review:${since}`] });
          continue;
        }
      }
      merges.push(merge);
      continue;
    }
    if (run?.conclusion === 'cancelled') {
      const source_ids = [`${run.run_id}/attempts/${run.run_attempt}`, pr.node_id];
      if (nowMs - Date.parse(run.updated_at) < CI_CANCELLED_GRACE_MINUTES * 60_000) {
        out.push(decide({ ...base, type: 'wait', reason: 'ci_cancelled_grace', run_id: run.run_id, source_ids }));
      } else {
        escalate(decide({ ...base, type: 'needs_human', reason: 'ci_cancelled', effect: 'label:needs-human', run_id: run.run_id, contract_sha: c.last_commit_sha, source_ids }));
      }
      continue;
    }
    if (!run || !run.conclusion || !FAILED_CONCLUSIONS.has(run.conclusion)) continue;
    const h = history(task);
    if (h.repaired_run_ids.includes(run.run_id)) {
      // This failure was already sent to repair. Once that repair run has finished and the PR head is
      // still the one it was asked to fix, it pushed nothing: a person, never another repair.
      const ended = finishedRepair(s, task, run.run_id, pr.head_sha, h);
      if (ended) {
        escalate(decide({
          ...base, type: 'needs_human', reason: ended.conclusion === 'success' ? 'repair_no_push' : 'repair_failed', effect: 'label:needs-human',
          run_id: run.run_id, contract_sha: c.last_commit_sha, source_ids: [`${run.run_id}/attempts/${run.run_attempt}`, pr.node_id, `repair_run:${ended.id}`],
        }));
      }
      continue;
    }
    // Nothing is repaired until the trusted gates have passed on this exact head
    // (missing, still running, cancelled or skipped gates → wait).
    if (gates?.conclusion !== 'success') {
      out.push(decide({ ...base, type: 'wait', reason: 'gates_pending', run_id: run.run_id, source_ids: [`${run.run_id}/attempts/${run.run_attempt}`, pr.node_id] }));
      continue;
    }
    // Only a plain failure is repairable (the repair workflow accepts nothing else): a timed-out
    // or never-started run goes to a person, without spending a repair attempt.
    if (run.conclusion !== 'failure') {
      escalate(decide({ ...base, type: 'needs_human', reason: 'ci_not_repairable', effect: 'label:needs-human', run_id: run.run_id, contract_sha: c.last_commit_sha, source_ids: [`${run.run_id}/attempts/${run.run_attempt}`, pr.node_id] }));
      continue;
    }
    const sig = run.failure_signature;
    // Per-task spend from the collector (measured + reserved, unattributed runs included), plus
    // what this repair may cost at most: never more than budgets.per_task.max_aic. Unknown: a person.
    // A task listed in unknown_tasks has an unreadable run of its own (attributed through the audit
    // dispatch record): its spend is unknown, the other tasks' isn't.
    const ts = s.task_spend;
    const spent = ts && !(ts.unknown_tasks ?? []).includes(task) ? Math.max(h.aic_spent, (ts.by_task[task] ?? 0) + ts.unattributed) : null;
    const repairCap = p.budgets.per_run.repair + p.budgets.per_run.threat_detection;
    const failure = {
      ...base,
      run_id: run.run_id,
      failure_signature: sig,
      contract_sha: c.last_commit_sha,
      source_ids: [`${run.run_id}/attempts/${run.run_attempt}`, pr.node_id],
    };
    if (!sig) {
      escalate(decide({ ...failure, type: 'needs_human', reason: 'missing_failure_signature', effect: 'label:needs-human' }));
    } else if (p.limits.task.stop_on_repeated_signature && h.failure_signatures.includes(sig)) {
      escalate(decide({ ...failure, type: 'needs_human', reason: 'repeated_signature', effect: 'label:needs-human' }));
    } else if (h.repairs >= p.limits.task.max_repairs) {
      escalate(decide({ ...failure, type: 'needs_human', reason: 'max_repairs', effect: 'label:needs-human' }));
    } else if (spent === null) {
      escalate(decide({ ...failure, type: 'needs_human', reason: 'task_budget_unknown', effect: 'label:needs-human' }));
    } else if (spent + repairCap > p.budgets.per_task.max_aic) {
      escalate(decide({ ...failure, type: 'needs_human', reason: 'task_budget_exhausted', effect: 'label:needs-human' }));
    } else {
      repairs.push({ ...decide({ ...failure, type: 'repair_dispatched', reason: 'ci_failed', effect: 'dispatch_workflow:repair', attempt: h.repairs + 2 }), head_sha: pr.head_sha });
    }
  }

  // ---- admission
  const admissible: { issue: IssueSnap; contract: ContractSnap; decision: Decision }[] = [];
  const seenTasks = new Set<string>();
  for (const issue of openIssues) {
    if (!issue.labels.includes(LABEL_READY)) continue;
    if (issue.labels.includes(LABEL_NEEDS_HUMAN) || issue.labels.includes(LABEL_PICKED)) continue;
    const base = { issue: issue.number, task: issue.task_id };
    if (issue.marker_status !== 'ok' || !issue.task_id) {
      out.push(decide({ ...base, type: 'blocked', reason: 'missing_task_marker', effect: 'label:blocked', source_ids: [issue.node_id] }));
      continue;
    }
    const task = issue.task_id;
    if (seenTasks.has(task)) {
      out.push(decide({ ...base, type: 'blocked', reason: 'duplicate_task', effect: 'label:blocked', source_ids: [issue.node_id] }));
      continue;
    }
    seenTasks.add(task);
    if (inFlight.has(task)) continue;
    if (mergedTasks.has(task)) {
      out.push(decide({ ...base, type: 'wait', reason: 'already_merged', source_ids: [issue.node_id] }));
      continue;
    }
    const c = contractOf(s, task);
    if (!c) {
      out.push(decide({ ...base, type: 'blocked', reason: 'contract_missing', effect: 'label:blocked', source_ids: [issue.node_id] }));
      continue;
    }
    if (!c.valid) {
      out.push(decide({ ...base, type: 'blocked', reason: 'invalid_contract', effect: 'label:blocked', contract_sha: c.last_commit_sha, source_ids: [issue.node_id, c.last_commit_sha] }));
      continue;
    }
    if (!c.depends_on.every((d) => mergedTasks.has(d))) {
      out.push(decide({ ...base, type: 'wait', reason: 'deps_not_merged', source_ids: [issue.node_id] }));
      continue;
    }
    admissible.push({
      issue,
      contract: c,
      // A re-dispatch (after a reopen) is the next attempt.
      decision: (() => {
        const attempt = (history(task).dispatches ?? 0) + 1;
        // Its audit identity is the reopen it follows (stable even when older dispatches leave the
        // audit window and the attempt count repeats); a first dispatch keeps its old identity.
        const reset = history(task).reset_at;
        return decide({ ...base, type: 'dispatched', reason: 'would_dispatch', effect: 'dispatch_workflow:implement', attempt: reset ? Math.max(attempt, 2) : attempt, contract_sha: c.last_commit_sha, source_ids: [issue.node_id, c.last_commit_sha, ...(reset ? [`reopened:${reset}`] : [])] });
      })(),
    });
  }
  // Dependency order, then priority (lower first), then issue number.
  const depth = new Map(admissible.map((a) => [a.contract.id ?? '', dependencyDepth(s, a.contract.id ?? '')]));
  admissible.sort((a, b) => {
    const da = depth.get(a.contract.id ?? '')!;
    const db = depth.get(b.contract.id ?? '')!;
    if (da !== db) return da - db;
    const pa = a.contract.priority ?? Number.POSITIVE_INFINITY;
    const pb = b.contract.priority ?? Number.POSITIVE_INFINITY;
    if (pa !== pb) return pa - pb;
    return a.issue.number - b.issue.number;
  });

  // ---- dispatch gates: kill switch, budget, Actions load, WIP, human queue, core, area
  const killed: Decision[] = [];
  const jobsPerDispatch = p.limits.ci.max_jobs_per_pr;
  const busyLimit = p.limits.wip.adaptive.pause_dispatch_when_busy_jobs_over;
  let planned = 0;
  const globalGate = (): ReasonCode | null => {
    if (!killSwitchEnabled(env)) return 'kill_switch';
    if (budget === 'unknown') return 'budget_unknown';
    if (budget === 'paused') return 'budget_pause';
    if (s.busy_jobs === null || !Number.isFinite(s.busy_jobs)) return 'busy_jobs_unknown';
    if (s.busy_jobs + planned * jobsPerDispatch > busyLimit) return 'actions_busy';
    return null;
  };
  const route = (d: Decision, gate: ReasonCode | null): boolean => {
    if (gate === 'kill_switch') killed.push(d);
    else if (gate) out.push(wait(gate, d));
    return gate === null;
  };

  for (const m of merges) {
    if (m.task && escalated.has(m.task)) continue;
    if (route(m, killSwitchEnabled(env) ? null : 'kill_switch')) out.push(m);
  }
  for (const d of dones) if (route(d, killSwitchEnabled(env) ? null : 'kill_switch')) out.push(d);
  for (const d of reverts) if (route(d, killSwitchEnabled(env) ? null : 'kill_switch')) out.push(d);

  for (const r of reviews) {
    if (r.task && escalated.has(r.task)) continue;
    if (route(r, globalGate())) {
      out.push(r);
      planned++;
    }
  }

  for (const r of repairs) {
    if (r.task && escalated.has(r.task)) continue;
    if (route(r, globalGate())) {
      out.push(r);
      planned++;
    }
  }

  // ---- needs-human pre-triage (triage.md): one read-only agent comment per hand-off, so the
  // person's step is a decision. Only when budgets.yaml caps it (per_run.needs_human_triage), and
  // behind the same gates as every AI dispatch (kill switch, spend, Actions load).
  for (const t of triageCandidates(s, p, out, now)) {
    if (route(t, globalGate())) {
      out.push(t);
      planned++;
    }
  }

  const wipLimit = Math.max(1, Math.min(p.limits.wip.start, p.limits.wip.max));
  const active: ContractSnap[] = [];
  for (const t of inFlight) {
    const c = contractOf(s, t);
    if (c) active.push(c);
  }
  let wip = inFlight.size;
  // Strict lane (limits.wip.core_area, factory-wide): core paths and every task whose effective
  // tier is auto-strict (by its paths or its contract), so at most that many are in flight at once.
  const strictLane = (c: ContractSnap): boolean => isCoreTask(c, p.tiers) || taskTier(c, p.tiers) === 'auto-strict';
  let core = active.filter(strictLane).length;
  // Hard cap: never more than one auto-strict task in flight, whatever limits.yaml says.
  const strictLaneLimit = Math.min(1, p.limits.wip.core_area);
  let humanItems = humanQueue.size;
  const admittedNow = new Set<string>();

  for (const a of admissible) {
    const d = a.decision;
    let gate = globalGate();
    const tier = taskTier(a.contract, p.tiers);
    const isCore = strictLane(a.contract);
    if (!gate && wip >= wipLimit) gate = 'wip_full';
    if (!gate && tier === 'human' && humanItems > p.limits.human_queue.max_items) gate = 'human_queue_full';
    if (!gate && isCore && core >= strictLaneLimit) gate = 'core_area_busy';
    if (!gate && active.some((c) => sameArea(c, a.contract))) gate = 'area_locked';
    if (route(d, gate)) {
      out.push(d);
      planned++;
      wip++;
      if (isCore) core++;
      if (tier === 'human') humanItems++;
      active.push(a.contract);
      if (a.contract.id) admittedNow.add(a.contract.id);
    }
  }

  // ---- auto-ready (limits.yaml `auto_ready: true`): mark unblocked autonomous-tier tasks ready,
  // only as many as the same WIP, area-lock and core limits leave room for. Ready issues that are
  // still waiting hold their slot and area too, so this never queues more than can run.
  if (p.limits.auto_ready === true) {
    const reserved = [...active];
    let slots = wip;
    let strictN = core;
    for (const i of openIssues) {
      if (!i.task_id || !i.labels.includes(LABEL_READY) || i.labels.includes(LABEL_PICKED) || admittedNow.has(i.task_id) || inFlight.has(i.task_id) || mergedTasks.has(i.task_id)) continue;
      // Only a ready issue that could actually be dispatched holds a slot: one blocked on its
      // dependencies, or without a usable contract, would otherwise starve its own prerequisites.
      const c = contractOf(s, i.task_id);
      if (!c || !c.valid || !c.depends_on.every((d) => mergedTasks.has(d))) continue;
      slots++;
      reserved.push(c);
      if (isCoreTask(c, p.tiers)) strictN++;
    }
    const candidates: { issue: IssueSnap; contract: ContractSnap }[] = [];
    const seen = new Set<string>();
    for (const i of openIssues) {
      const task = i.task_id;
      if (!task || i.marker_status !== 'ok' || !i.labels.includes(LABEL_TASK)) continue;
      if (seen.has(task)) continue; // duplicates are the admission's to report
      seen.add(task);
      if (i.labels.includes(LABEL_READY) || i.labels.includes(LABEL_PICKED) || AUTO_READY_HOLDS.some((l) => i.labels.includes(l))) continue;
      if (inFlight.has(task) || mergedTasks.has(task)) continue;
      const c = contractOf(s, task);
      if (!c || !c.valid || !autonomousTier(c, p)) continue;
      if (!c.depends_on.every((d) => mergedTasks.has(d))) continue;
      candidates.push({ issue: i, contract: c });
    }
    candidates.sort((a, b) => {
      const da = dependencyDepth(s, a.contract.id ?? '');
      const db = dependencyDepth(s, b.contract.id ?? '');
      if (da !== db) return da - db;
      const pa = a.contract.priority ?? Number.POSITIVE_INFINITY;
      const pb = b.contract.priority ?? Number.POSITIVE_INFINITY;
      if (pa !== pb) return pa - pb;
      return a.issue.number - b.issue.number;
    });
    for (const { issue, contract: c } of candidates) {
      if (slots >= wipLimit) break;
      const strictTask = isCoreTask(c, p.tiers);
      if (strictTask && strictN >= p.limits.wip.core_area) continue;
      if (reserved.some((r) => sameArea(r, c))) continue;
      const d = decide({ type: 'auto_ready', reason: 'deps_merged', effect: 'label:ready', task: c.id, issue: issue.number, contract_sha: c.last_commit_sha, source_ids: [issue.node_id, c.last_commit_sha] });
      if (route(d, killSwitchEnabled(env) ? null : 'kill_switch')) out.push(d);
      slots++;
      reserved.push(c);
      if (strictTask) strictN++;
    }
  }

  if (killed.length > 0) {
    const ids = new Set<string>();
    for (const k of killed) for (const id of k.source_ids) ids.add(id);
    out.push(decide({ type: 'kill_switch', reason: 'kill_switch', effect: 'none', source_ids: [...ids].sort() }));
  }
  return out;
}

/** Decisions that are recorded as audit events (everything except waits). */
export function isRecorded(d: Decision): boolean {
  return d.type !== 'wait';
}
