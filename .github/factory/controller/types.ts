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
}

export interface BudgetsPolicy {
  version: number;
  per_task: { max_aic: number };
  factory_per_day: { max_aic: number; alert_at_pct: number; pause_at_pct: number };
}

export type Tier = 'auto' | 'auto-strict' | 'human';

export interface TiersPolicy {
  version: number;
  tiers: {
    auto: { paths: string[] };
    'auto-strict': { paths: string[]; start_as?: Tier };
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

export type CheckEvent = 'pull_request' | 'pull_request_target' | 'merge_group';

export interface CheckRunSnap {
  run_id: number;
  run_attempt: number;
  workflow: string;
  event: CheckEvent;
  head_sha: string;
  pull_requests: number[];
  status: string;
  conclusion: string | null;
  created_at: string;
  updated_at: string;
  /** Decimal string from the `factory-heldout-seed: <n>` log line of the `checks` job. */
  heldout_seed: string | null;
  /** From the `factory-failure-signature: <sig>` log line of the `checks` job. */
  failure_signature: string | null;
}

export interface TaskHistory {
  picked_at: string | null;
  repairs: number;
  failure_signatures: string[];
  repaired_run_ids: number[];
  aic_spent: number;
}

export interface Snapshot {
  repo: string;
  fetched_at: string;
  issues: IssueSnap[];
  pulls: PullSnap[];
  /** Keyed by repo path, e.g. `contracts/en/weekday-parser.yaml`. */
  contracts: Record<string, ContractSnap>;
  check_runs: CheckRunSnap[];
  /** Running + queued Actions jobs across the org; null when unknown. */
  busy_jobs: number | null;
  /** Factory-wide AIC spent today (UTC); null when unknown. */
  factory_aic_today: number | null;
  /** Per task id, derived from non-dry-run audit events. */
  history: Record<string, TaskHistory>;
}

// ---------------------------------------------------------------- decisions

export type DecisionType =
  | 'dispatched'
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
  | 'missing_failure_signature'
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
  | 'area_locked';

export type Effect =
  | 'dispatch_workflow:implement'
  | 'dispatch_workflow:repair'
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
  /** Payload fields without dedupe_key/factory_version/dry_run. */
  fields: JsonObject;
}

// ---------------------------------------------------------------- GitHub

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface RequestOptions {
  body?: unknown;
  /** `raw` returns the response body as text. */
  accept?: 'json' | 'raw';
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
