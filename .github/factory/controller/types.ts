// Shared types for controller v1. Only erasable TypeScript syntax is used so
// Node can run these files directly with type stripping.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

// ---------------------------------------------------------------- policies

export interface LimitsPolicy {
  version: number;
  wip: {
    start: number;
    max: number;
    adaptive: { org_concurrent_job_limit: number; pause_dispatch_when_busy_jobs_over: number };
    core_area: number;
  };
  ci: { max_jobs_per_pr: number };
  task: {
    max_attempts: number;
    max_repairs: number;
    stop_on_repeated_signature: boolean;
    max_wall_clock_hours: number;
    flaky_requeue: number;
  };
  human_queue: { max_items: number };
  fail_closed: boolean;
  /** limits.yaml `auto_ready`: the controller marks unblocked tasks `factory:ready` itself. Missing → false. */
  auto_ready?: boolean;
}

export interface BudgetsPolicy {
  version: number;
  per_task: { max_aic: number };
  factory_per_day: { max_aic: number; alert_at_pct: number; pause_at_pct: number };
  /** Per-run caps (gh-aw max-ai-credits); used to reserve spend for runs still going. */
  per_run: { implement: number; repair: number; reviewer_agent: number; threat_detection: number; overshoot?: Overshoot | null };
}

/**
 * budgets.yaml per_run.overshoot_margin and its assumptions. max-ai-credits is "stop after the
 * response that crosses the cap" (the firewall checks the recorded total before each request), so
 * an AI job can spend up to `margin` = max response × max concurrency past its cap.
 */
export interface Overshoot {
  margin: number;
  max_response_aic: number;
  max_concurrency: number;
}

export type Tier = 'auto' | 'auto-strict' | 'human';

export interface TiersPolicy {
  version: number;
  tiers: {
    auto: { paths: string[] };
    /**
     * `strict_gates`: the gate names tiers.yaml lists (a `name: value` entry counts by its name);
     * null when missing or malformed (then no promotion takes effect: fail closed).
     */
    'auto-strict': { paths: string[]; start_as?: Tier; strict_gates: string[] | null };
    human: { paths: string[] };
  };
  protected_from_agents: string[];
}

export interface CadencePolicy {
  version: number;
  heartbeat: string;
  [key: string]: unknown;
}

export interface Policies {
  limits: LimitsPolicy;
  budgets: BudgetsPolicy;
  tiers: TiersPolicy;
  cadence: CadencePolicy;
}

// ---------------------------------------------------------------- snapshot

export type MarkerStatus = 'ok' | 'missing' | 'invalid';

export interface IssueSnap {
  number: number;
  node_id: string;
  labels: string[];
  /** Parsed only from the hidden `<!-- factory-task: ... -->` marker. */
  task_id: string | null;
  marker_status: MarkerStatus;
  /** When the issue was last reopened (only read for issues whose task has a recorded pick); null if never or unknown. */
  reopened_at?: string | null;
}

export interface ReviewSnap {
  node_id: string;
  author: string | null;
  author_is_bot: boolean;
  state: string;
  submitted_at: string | null;
}

export interface MergeQueueEventSnap {
  node_id: string;
  kind: 'queued' | 'dequeued';
  created_at: string;
  actor: string | null;
  /** RemovedFromMergeQueueEvent.reason (e.g. "merged"); null for queued events. */
  reason?: string | null;
}

export type PullState = 'open' | 'closed' | 'merged';

export interface PullSnap {
  number: number;
  node_id: string;
  state: PullState;
  draft: boolean;
  author: string | null;
  author_is_bot: boolean;
  head_sha: string;
  created_at: string;
  merged_at: string | null;
  merge_commit_sha: string | null;
  labels: string[];
  /** From the `Factory-Task:` trailer line. */
  task_id: string | null;
  /** From the `Contract-SHA:` trailer line. */
  contract_sha: string | null;
  /** From the `Factory-Attempt:` trailer line. */
  attempt: number | null;
  reviews: ReviewSnap[];
  merge_queue_events: MergeQueueEventSnap[];
  /** GitHub's `mergeable` ('MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'); null when not read. */
  mergeable?: string | null;
  /** GitHub's `isInMergeQueue`. */
  in_merge_queue?: boolean;
  /** The PR's head branch name (`headRefName`); revert PRs use `factory/revert-<pr>`. */
  head_ref?: string | null;
  /** Timeline `LabeledEvent`s: who added which label (to tell a person from a bot). */
  labeled_events?: { label: string; actor: string | null; actor_is_bot: boolean; at: string }[];
}

export interface ContractSnap {
  path: string;
  /** Git blob SHA of the contract file on main (informational). */
  blob_sha: string;
  /**
   * The contract version (DESIGN §11 "spec version"): SHA of the last commit on
   * main that touched this file. Compared with the PR's `Contract-SHA:`.
   */
  last_commit_sha: string;
  valid: boolean;
  id: string | null;
  tier: Tier | null;
  depends_on: string[];
  scope: string[];
  priority: number | null;
  area: string | null;
}

export type CheckEvent = 'pull_request' | 'pull_request_target' | 'merge_group' | 'push';

export interface CheckRunSnap {
  run_id: number;
  run_attempt: number;
  workflow: string;
  event: CheckEvent;
  head_sha: string;
  /**
   * The commit the run judged: `head_sha` for `pull_request`/`merge_group`;
   * for `pull_request_target` (gates) the PR head from the run's
   * `pull_requests[].head.sha`, because `head_sha` is then the main tip.
   */
  candidate_sha: string | null;
  pull_requests: number[];
  status: string;
  conclusion: string | null;
  created_at: string;
  updated_at: string;
  /**
   * Decimal string: the `checks` job's held-out seed, accepted only through the commit–reveal
   * anchored in its trusted first step (see `parseHeldoutSeed`).
   */
  heldout_seed: string | null;
  /** `step:<first failed step>` or `job:<conclusion>`, from runner-reported step results (never log text). */
  failure_signature: string | null;
  /**
   * Runner-reported conclusion of the `checks` job's full-regression step (auto-strict:
   * FULL_REGRESSION_STEP), e.g. `success` or `skipped`; null when the step isn't in the job or the
   * run's signals aren't trusted (a `.github/` change).
   */
  full_regression?: string | null;
  /** For a re-run (attempt ≥ 2): attempt 1's recorded failure signature, or null if unknown. */
  first_attempt_signature?: string | null;
}

export interface TaskHistory {
  /** The first recorded pick (after the issue's last reopen, once applyReopens has run). */
  picked_at: string | null;
  /** Every recorded pick or dispatch time, and the number of implement dispatches (the next attempt). */
  picks?: string[];
  dispatches?: number;
  repairs: number;
  failure_signatures: string[];
  repaired_run_ids: number[];
  aic_spent: number;
  /** Live merge-queue enqueues by the controller (from `auto_merge` events): which head, when. */
  enqueued?: { pr: number; head: string; at: string }[];
  /** Live repair dispatches (from `repair_dispatched` events): the failing run, the PR head, when. */
  repair_dispatches?: { run_id: number; head: string; issue: number; attempt: number; at: string }[];
  /** Live reviewer-agent dispatches (from `review_dispatched` events): which PR head, against which contract, when. */
  reviews?: { pr: number; head: string; contract: string | null; at: string }[];
  /** Live auto-reverts (from `auto_revert` events): the reverted PR and its revert PR. */
  reverts?: { pr: number; revert_pr: number | null; revert_commit?: string | null; at: string }[];
}

/**
 * A `factory-review` check run on an open factory PR head, kept only if the reviewer App
 * (REVIEWER_APP_ID, 5444751) created it. `reviewed_head` is the SHA on the summary's first line
 * (`Reviewed-Head: <sha>`), or null.
 */
export interface ReviewCheckSnap {
  id: number;
  head_sha: string;
  status: string;
  conclusion: string | null;
  started_at: string;
  reviewed_head: string | null;
}

export interface Snapshot {
  repo: string;
  fetched_at: string;
  issues: IssueSnap[];
  pulls: PullSnap[];
  /** The main commit the contracts were read at (resolved once per run); null when not read. */
  main_sha: string | null;
  /** Keyed by repo path, e.g. `contracts/en/weekday-parser.yaml`. */
  contracts: Record<string, ContractSnap>;
  check_runs: CheckRunSnap[];
  /**
   * Open PR heads whose runs were NOT looked up (beyond MAX_HEAD_LOOKUPS, or not a
   * 40-hex SHA). Their newest run may be missing, so the planner waits on them.
   */
  unchecked_heads: string[];
  /** Running + queued Actions jobs across the org; null when unknown. */
  busy_jobs: number | null;
  /**
   * Factory-wide AIC spent today (UTC); null when unknown, i.e. when no
   * `spend_snapshot` record exists for today. Unknown fails closed.
   */
  factory_aic_today: number | null;
  /** Per task id, derived from non-dry-run audit events. */
  history: Record<string, TaskHistory>;
  /** Reviewer-App `factory-review` check runs on open factory PR heads (absent = none). */
  review_checks?: ReviewCheckSnap[];
  /**
   * Per-task AIC over today and yesterday from the spend collector (measured runs plus
   * reservations for runs in flight; runs naming no task count against every task). Null or
   * missing: unknown, so no repair is paid for (fail closed).
   */
  task_spend?: { by_task: Record<string, number>; unattributed: number; unknown_tasks?: string[] } | null;
  /** Recent runs of the repair workflow (two days); null when they couldn't be listed (unknown). */
  repair_runs?: RepairRunSnap[] | null;
}

/** A run of repair.lock.yml. Its name is `Repair <task> #<issue> attempt <n>` (only a lookup key). */
export interface RepairRunSnap {
  id: number;
  display_title: string;
  created_at: string;
  status: string;
  conclusion: string | null;
}

// ---------------------------------------------------------------- decisions

export type DecisionType =
  | 'dispatched'
  | 'auto_merge'
  | 'review_dispatched'
  | 'auto_ready'
  | 'auto_revert'
  | 'main_ci_rerun'
  | 'task_done'
  | 'repair_dispatched'
  | 'needs_human'
  | 'blocked'
  | 'stale_contract'
  | 'budget_alert'
  | 'budget_pause'
  | 'kill_switch'
  | 'wait';

export type ReasonCode =
  // recorded decisions
  | 'would_dispatch'
  | 'ci_failed'
  | 'task_timeout'
  | 'repeated_signature'
  | 'max_repairs'
  | 'repair_no_push'
  | 'repair_failed'
  | 'missing_failure_signature'
  | 'pick_time_unknown'
  | 'missing_heldout_seed'
  | 'repair_unavailable'
  | 'ci_not_repairable'
  | 'task_budget_unknown'
  | 'auto_merge_ready'
  | 'review_needed'
  | 'review_objected'
  | 'review_timeout'
  | 'review_contract_changed'
  | 'deps_merged'
  | 'full_regression_missing'
  | 'task_merged'
  | 'main_regressed'
  | 'revert_limit'
  | 'revert_not_safe'
  | 'revert_ready'
  | 'revert_checks_failed'
  | 'revert_head_changed'
  | 'confirm_regression'
  | 'merge_queue_rejected'
  | 'enqueue_failed'
  | 'gates_failed'
  | 'task_budget_exhausted'
  | 'missing_task_marker'
  | 'duplicate_task'
  | 'contract_missing'
  | 'invalid_contract'
  | 'missing_contract_sha'
  | 'contract_changed'
  | 'budget_alert'
  | 'budget_pause'
  | 'kill_switch'
  // waits (logged, not recorded)
  | 'already_merged'
  | 'deps_not_merged'
  | 'budget_unknown'
  | 'busy_jobs_unknown'
  | 'actions_busy'
  | 'wip_full'
  | 'human_queue_full'
  | 'core_area_busy'
  | 'area_locked'
  | 'merge_not_ready'
  | 'review_pending'
  | 'gates_pending'
  | 'check_runs_incomplete';

export type Effect =
  | 'dispatch_workflow:implement'
  | 'dispatch_workflow:repair'
  | 'dispatch_workflow:review'
  | 'enqueue_merge'
  | 'label:ready'
  | 'close_task'
  | 'open_revert'
  | 'rerun_ci'
  | 'label:needs-human'
  | 'label:blocked'
  | 'label:stale-contract'
  | 'alert:owner'
  | 'pause_dispatch'
  | 'none';

export interface Decision {
  type: DecisionType;
  reason: ReasonCode;
  effect: Effect;
  dry_run: true;
  task: string | null;
  issue: number | null;
  pr: number | null;
  attempt: number | null;
  contract_sha: string | null;
  run_id: number | null;
  failure_signature: string | null;
  /** The PR head this decision is about (merge-stage decisions). */
  head_sha?: string | null;
  /** The merge commit on main to revert (auto_revert). */
  merge_commit_sha?: string | null;
  /** Deterministic GitHub IDs/SHAs this decision is about; feeds the dedupe key. */
  source_ids: string[];
}

export interface PlannerEnv {
  FACTORY_ENABLED: string | undefined;
}

// ---------------------------------------------------------------- audit

export interface AuditEvent {
  version: 1;
  id: string;
  type: string;
  timestamp: string;
  parents: string[];
  payload: JsonObject;
  sha: string;
}

/** An event the controller wants to record, before chain fields are added. */
export interface PendingEvent {
  type: string;
  source_ids: string[];
  /** Overrides the log's dry_run flag: measurements (spend_snapshot) are real in both modes. */
  dry_run?: boolean;
  /** Payload fields without dedupe_key/factory_version/dry_run. */
  fields: JsonObject;
}

// ---------------------------------------------------------------- GitHub

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface RequestOptions {
  body?: unknown;
  /** `raw` returns the response body as text. */
  /** `raw` returns text, `binary` a Uint8Array (artifact zips). */
  accept?: 'json' | 'raw' | 'binary';
  /** Statuses returned to the caller instead of thrown. */
  allowStatuses?: number[];
}

export interface ApiResponse {
  status: number;
  data: unknown;
  /** Path of the next page (from the Link header), if any. */
  next: string | null;
}

export interface GitHubClient {
  request(method: HttpMethod, path: string, options?: RequestOptions): Promise<ApiResponse>;
}
