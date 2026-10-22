// The planner (DESIGN §7): a PURE function from a snapshot of GitHub plus
// policies to a list of decisions with stable reason codes. No I/O, no clock
// reads (`now` is an argument), no randomness.

import { contractPath, contractShaMatches, isCoreTask, sameArea, taskTier } from './tasks.ts';
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
  Snapshot,
  TaskHistory,
} from './types.ts';

export const LABEL_READY = 'factory:ready';
export const LABEL_PICKED = 'factory:picked';
export const LABEL_NEEDS_HUMAN = 'needs-human';
/** The agent App's login (GraphQL gives `name`, REST `name[bot]`). Only its PRs are auto-merged. */
export const AGENT_LOGIN = 'sabbasi3-factory-agent';

/**
 * The merge stage (DESIGN §7 step 5): a factory PR goes to the merge queue only if every
 * condition holds. Returns the reason it can't (a wait), or null when it can.
 * Never for human, auto-strict or core tasks: those always wait for a person.
 */
export function autoMergeBlocker(pr: PullSnap, c: ContractSnap, issue: IssueSnap | undefined, ci: CheckRunSnap | null, gates: CheckRunSnap | null, p: Policies): string | null {
  if (taskTier(c, p.tiers) !== 'auto' || isCoreTask(c, p.tiers)) return 'not_auto_tier';
  if (pr.draft) return 'draft';
  if (!pr.author_is_bot || (pr.author ?? '').replace(/\[bot\]$/, '') !== AGENT_LOGIN) return 'not_agent_pr';
  if (pr.contract_sha !== c.last_commit_sha) return 'contract_sha_not_exact';
  if (!issue || !issue.labels.includes(LABEL_PICKED)) return 'issue_not_picked';
  if (ci?.conclusion !== 'success' || ci.heldout_seed === null) return 'ci_not_green';
  if (gates?.conclusion !== 'success') return 'gates_not_green';
  if (pr.mergeable !== 'MERGEABLE') return 'not_mergeable';
  return null;
}

/** ci conclusions after which the reveal step has run, so a held-out seed must exist. */
export const SEED_EXPECTED_CONCLUSIONS = new Set(['success', 'failure']);

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

function wait(reason: ReasonCode, base: Decision): Decision {
  return { ...base, type: 'wait', reason, effect: 'none' };
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

export function plan(s: Snapshot, p: Policies, env: PlannerEnv, now: Date): Decision[] {
  const out: Decision[] = [];
  const day = now.toISOString().slice(0, 10);
  const nowMs = now.getTime();

  const mergedTasks = new Set<string>();
  for (const pr of s.pulls) if (pr.state === 'merged' && pr.task_id) mergedTasks.add(pr.task_id);
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
  const inFlight = new Set<string>();
  for (const pr of openPulls) if (pr.task_id) inFlight.add(pr.task_id);
  for (const i of openIssues) {
    if (!i.task_id || mergedTasks.has(i.task_id)) continue;
    if (i.labels.includes(LABEL_PICKED) || history(i.task_id).picked_at) inFlight.add(i.task_id);
  }

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

  // ---- open factory PRs: contract freshness and CI failures
  for (const pr of openPulls) {
    if (!pr.task_id || pr.labels.includes(LABEL_NEEDS_HUMAN) || escalated.has(pr.task_id)) continue;
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
    if (run && run.heldout_seed === null && SEED_EXPECTED_CONCLUSIONS.has(run.conclusion ?? '')) {
      escalate(decide({ ...base, type: 'needs_human', reason: 'missing_heldout_seed', effect: 'label:needs-human', run_id: run.run_id, contract_sha: c.last_commit_sha, source_ids: [`${run.run_id}/attempts/${run.run_attempt}`, pr.node_id] }));
      continue;
    }
    // ---- merge stage: green auto-tier agent PRs go to the merge queue (live), nothing else does.
    if (run?.conclusion === 'success' && gates?.conclusion === 'success' && taskTier(c, p.tiers) === 'auto' && !isCoreTask(c, p.tiers)) {
      if (pr.in_merge_queue) continue;
      const issue = issueByTask.get(task);
      // Removed from the queue after this head's green CI (merge-group checks failed, or a person
      // dequeued it): a person decides; it's never re-queued automatically.
      const lastMq = [...pr.merge_queue_events].sort((a, b) => a.created_at.localeCompare(b.created_at)).at(-1);
      if (lastMq?.kind === 'dequeued' && lastMq.created_at > run.created_at) {
        escalate(decide({ ...base, type: 'needs_human', reason: 'merge_queue_rejected', effect: 'label:needs-human', run_id: run.run_id, contract_sha: c.last_commit_sha, source_ids: [pr.node_id, lastMq.node_id] }));
        continue;
      }
      const blocker = autoMergeBlocker(pr, c, issue, run, gates, p);
      const merge = decide({ ...base, type: 'auto_merge', reason: 'auto_merge_ready', effect: 'enqueue_merge', run_id: run.run_id, contract_sha: c.last_commit_sha, source_ids: [pr.node_id, pr.head_sha] });
      if (blocker !== null) {
        out.push({ ...wait('merge_not_ready', merge), source_ids: [pr.node_id, pr.head_sha, `blocker:${blocker}`] });
        continue;
      }
      merges.push(merge);
      continue;
    }
    if (!run || !run.conclusion || !FAILED_CONCLUSIONS.has(run.conclusion)) continue;
    const h = history(task);
    if (h.repaired_run_ids.includes(run.run_id)) continue;
    // Nothing is repaired until the trusted gates have passed on this exact head
    // (missing, still running, cancelled or skipped gates → wait).
    if (gates?.conclusion !== 'success') {
      out.push(decide({ ...base, type: 'wait', reason: 'gates_pending', run_id: run.run_id, source_ids: [`${run.run_id}/attempts/${run.run_attempt}`, pr.node_id] }));
      continue;
    }
    const sig = run.failure_signature;
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
    } else if (h.aic_spent >= p.budgets.per_task.max_aic) {
      escalate(decide({ ...failure, type: 'needs_human', reason: 'task_budget_exhausted', effect: 'label:needs-human' }));
    } else {
      repairs.push(decide({ ...failure, type: 'repair_dispatched', reason: 'ci_failed', effect: 'dispatch_workflow:repair', attempt: h.repairs + 2 }));
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
      decision: decide({ ...base, type: 'dispatched', reason: 'would_dispatch', effect: 'dispatch_workflow:implement', attempt: 1, contract_sha: c.last_commit_sha, source_ids: [issue.node_id, c.last_commit_sha] }),
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

  for (const r of repairs) {
    if (r.task && escalated.has(r.task)) continue;
    if (route(r, globalGate())) {
      out.push(r);
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
  let core = active.filter((c) => isCoreTask(c, p.tiers)).length;
  let humanItems = humanQueue.size;

  for (const a of admissible) {
    const d = a.decision;
    let gate = globalGate();
    const tier = taskTier(a.contract, p.tiers);
    const isCore = isCoreTask(a.contract, p.tiers);
    if (!gate && wip >= wipLimit) gate = 'wip_full';
    if (!gate && tier === 'human' && humanItems > p.limits.human_queue.max_items) gate = 'human_queue_full';
    if (!gate && isCore && core >= p.limits.wip.core_area) gate = 'core_area_busy';
    if (!gate && active.some((c) => sameArea(c, a.contract))) gate = 'area_locked';
    if (route(d, gate)) {
      out.push(d);
      planned++;
      wip++;
      if (isCore) core++;
      if (tier === 'human') humanItems++;
      active.push(a.contract);
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
