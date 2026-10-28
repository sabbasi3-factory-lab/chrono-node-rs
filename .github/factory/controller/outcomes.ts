// Outcomes: gh-aw's own "Outcomes" evaluation of every agent run (implement, repair, review), as
// the factory's results measure. Plain code, no AI.
//
// Two halves share this module:
//   - the COLLECTOR (`collect-outcomes.ts`, run by `.github/workflows/outcomes.yml` with the job's
//     read-only GITHUB_TOKEN and no App key) lists the agent runs, decides which to (re)evaluate,
//     runs `gh aw outcomes <run-id>` for them and uploads one complete snapshot as the `outcomes`
//     artifact;
//   - the CONTROLLER (`ingestOutcomes`, called from main.ts) picks up the newest successful
//     outcomes run on main, validates its artifact strictly and appends ONE `outcomes_snapshot`
//     audit event (deduped by the outcomes run id and attempt). Failures are fail-soft.
//
// AI credits (`aic`) belong to the RUN, so they are on the run record and never repeated per item:
// summing `runs[].aic` counts every credit exactly once.

import { dedupeKey, isoSeconds, sha256Hex, type AuditLog } from './audit.ts';
import { canonicalize } from './canonical.ts';
import { paginate } from './github.ts';
import { readZip } from './spend.ts';
import { isTaskId, parsePrTrailers, parseTaskMarker } from './tasks.ts';
import type { GitHubClient, JsonObject, PendingEvent } from './types.ts';

export const OUTCOMES_EVENT = 'outcomes_snapshot';
/** A tiny marker: this outcomes run was checked and its runs were unchanged (nothing else recorded). */
export const OUTCOMES_CHECKED_EVENT = 'outcomes_checked';
export const OUTCOMES_WORKFLOW_FILE = 'outcomes.yml';
export const OUTCOMES_WORKFLOW_PATH = `.github/workflows/${OUTCOMES_WORKFLOW_FILE}`;
export const OUTCOMES_ARTIFACT = 'outcomes';
export const OUTCOMES_FILE = 'outcomes.json';
export const GH_AW_VERSION = 'v0.92.0';
export const SNAPSHOT_VERSION = 1;

/** A run younger than this is re-evaluated every time (its outcomes may still change). */
export const REEVALUATE_DAYS = 14;
/** Caps on what the controller accepts (and the collector produces). */
export const MAX_RUNS = 1000;
export const MAX_ITEMS_PER_RUN = 100;
export const MAX_ITEMS = 5000;
export const MAX_SNAPSHOT_BYTES = 1_000_000;
export const MAX_OUTCOMES_ZIP_BYTES = 2 * 1024 * 1024;
/**
 * The controller only ingests outcomes runs this recent, so a run it already ingested is always
 * still inside the audit window its dedupe check reads (7 days).
 */
export const INGEST_MAX_AGE_HOURS = 72;

/** gh-aw v0.92.0 `OutcomeStatus` (pkg/cli/outcome_evaluation.go): all nine values. */
export const OUTCOME_STATUSES = ['accepted', 'rejected', 'ignored', 'pending', 'unknown', 'skipped', 'lifecycle', 'lifecycle_close', 'error'] as const;
export type OutcomeStatus = (typeof OUTCOME_STATUSES)[number];
/** gh-aw v0.92.0 `EvidenceStrength`. */
export const EVIDENCE_STRENGTHS = ['strong', 'medium', 'weak', 'none'] as const;
export type EvidenceStrength = (typeof EVIDENCE_STRENGTHS)[number];
export const AGENT_WORKFLOWS = ['implement', 'repair', 'review'] as const;
export type AgentWorkflow = (typeof AGENT_WORKFLOWS)[number];
export const RUN_CONCLUSIONS = ['success', 'failure', 'cancelled', 'skipped', 'timed_out', 'action_required', 'neutral', 'stale', 'startup_failure'] as const;
export const EVAL_STATES = ['ok', 'stale', 'error'] as const;
export type EvalState = (typeof EVAL_STATES)[number];
/**
 * Events an ingested outcomes run may come from. Never `pull_request` (PR code). A
 * `pull_request_target` run executes the base branch's workflow, and outcomes.yml only accepts
 * PRs into main (`branches: [main]`), so it is main's code too.
 */
export const OUTCOMES_EVENTS = ['schedule', 'workflow_dispatch', 'workflow_run', 'pull_request_target'] as const;

export interface OutcomeItem {
  type: string;
  object_url: string | null;
  outcome_status: OutcomeStatus;
  evidence_strength: EvidenceStrength;
  zero_touch: boolean | null;
}

export interface OutcomeRun {
  run_id: number;
  workflow: AgentWorkflow;
  task: string | null;
  drill: boolean;
  created_at: string;
  /** gh-aw's AI credits for the whole run (once per run, never per item), or null if unknown. */
  aic: number | null;
  conclusion: string;
  /** ok: evaluated now or carried over; stale: this evaluation failed, previous items kept; error: failed, none kept. */
  eval: EvalState;
  /** When `items` were evaluated (null for `error`). */
  evaluated_at: string | null;
  items: OutcomeItem[];
  /**
   * gh-aw `audit` of an implement run that failed or opened no PR: its finding codes (at most 5,
   * most severe first) and the highest severity. Null when not applicable, not yet audited, or the
   * audit failed (retried next collection).
   */
  diagnosis: Diagnosis | null;
}

export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type Severity = (typeof SEVERITIES)[number];
export interface Diagnosis {
  codes: string[];
  severity: Severity | null;
}
export const MAX_DIAGNOSIS_CODES = 5;
export const DIAGNOSIS_CODE = /^[a-z][a-z0-9_]{0,63}$/;

/** Whether an implement run gets a gh-aw audit: it didn't succeed, or opened no PR. */
export function needsDiagnosis(run: { workflow: AgentWorkflow; conclusion: string }, items: readonly OutcomeItem[]): boolean {
  return run.workflow === 'implement' && (run.conclusion !== 'success' || !items.some((i) => i.type === 'create_pull_request'));
}

/**
 * A diagnosis from `gh aw audit <run> --json`: only `key_findings[].code` (stable enum-like codes)
 * and `severity`; titles and descriptions are free text and never kept. Throws if there are no
 * key_findings (the audit didn't produce a report).
 */
export function diagnosisFromAudit(raw: unknown): Diagnosis {
  const findings = (raw as { key_findings?: unknown } | null)?.key_findings;
  if (!Array.isArray(findings)) throw new Error('audit output has no key_findings');
  const rank = (s: unknown): number => {
    const i = (SEVERITIES as readonly unknown[]).indexOf(s);
    return i < 0 ? SEVERITIES.length : i;
  };
  const valid = findings
    .map((f) => (f ?? {}) as { code?: unknown; severity?: unknown })
    .filter((f): f is { code: string; severity?: unknown } => typeof f.code === 'string' && DIAGNOSIS_CODE.test(f.code));
  const sorted = valid.map((f, i) => ({ f, i })).sort((a, b) => rank(a.f.severity) - rank(b.f.severity) || a.i - b.i);
  const codes: string[] = [];
  for (const { f } of sorted) if (!codes.includes(f.code) && codes.length < MAX_DIAGNOSIS_CODES) codes.push(f.code);
  const top = sorted[0]?.f.severity;
  return { codes, severity: (SEVERITIES as readonly unknown[]).includes(top) ? (top as Severity) : null };
}

export interface OutcomesSummary {
  runs: number;
  items: number;
  accepted: number;
  rejected: number;
  ignored: number;
  pending: number;
  unknown: number;
  /** skipped, lifecycle, lifecycle_close and error items. */
  other: number;
  zero_touch: number;
  eval_stale: number;
  eval_error: number;
  /** Sum of the runs' aic (runs with a known aic only). */
  aic: number;
}

export interface OutcomesSnapshot {
  version: 1;
  repo: string;
  gh_aw_version: string;
  evaluated_at: string;
  mode: SnapshotMode;
  runs: OutcomeRun[];
  summary: OutcomesSummary;
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const ITEM_TYPE = /^[a-z][a-z0-9_]{0,63}$/;
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const objectUrlPattern = (repo: string): RegExp => new RegExp(`^https://github\\.com/${escapeRe(repo)}/(pull|issues)/[1-9][0-9]{0,9}(#issuecomment-[1-9][0-9]{0,19})?$`);

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------- task join

/** The task in a run title (`Implement <task> #<issue> attempt <n>`, `Repair …`), or null. */
export function taskFromTitle(title: string | null | undefined): string | null {
  const m = /^(?:Implement|Repair) (\S+) #[1-9][0-9]{0,8} attempt [1-9][0-9]?$/.exec(title ?? '') ?? /^Review (\S+) PR #[1-9][0-9]{0,8}$/.exec(title ?? '');
  return m && isTaskId(m[1]) ? m[1] : null;
}

/** A controller `review_dispatched` record (live): the review it asked for. */
export interface ReviewDispatch {
  task: string;
  pr: number;
  at: string;
}

/** The controller's live review dispatches in the loaded audit events. */
export function reviewDispatches(events: readonly { type: string; timestamp: string; payload: Record<string, unknown> }[]): ReviewDispatch[] {
  const out: ReviewDispatch[] = [];
  for (const e of events) {
    const { task, pr, dry_run } = e.payload;
    if (e.type !== 'review_dispatched' || dry_run !== false || !isTaskId(task) || typeof pr !== 'number' || !Number.isSafeInteger(pr) || pr <= 0) continue;
    out.push({ task, pr, at: e.timestamp });
  }
  return out;
}

/** How long after a review dispatch its run may be created and still be that dispatch's run. */
export const REVIEW_MATCH_MINUTES = 30;

/**
 * Untitled review runs ("Review one factory PR", before review.md had a run-name) → the dispatch
 * each started after: created at or after the dispatch, within 30 minutes; the nearest pairs first,
 * and at most one run per dispatch (and one dispatch per run). Unmatched runs are absent.
 * Pass every untitled run, including ones already attributed (`task` known, e.g. carried over from
 * an earlier collection, or titled): those can only take a dispatch of their own task and claim it
 * first, so the dispatch they used stays reserved and is never handed to another run later.
 */
export function matchReviewRuns(runs: readonly { run_id: number; created_at: string; task?: string | null }[], dispatches: readonly ReviewDispatch[]): Map<number, ReviewDispatch> {
  const pairs: { run: number; d: ReviewDispatch; gap: number; known: boolean }[] = [];
  for (const r of runs) {
    const created = Date.parse(r.created_at);
    for (const d of dispatches) {
      if (r.task && d.task !== r.task) continue;
      const gap = created - Date.parse(d.at);
      if (Number.isFinite(gap) && gap >= 0 && gap <= REVIEW_MATCH_MINUTES * 60_000) pairs.push({ run: r.run_id, d, gap, known: Boolean(r.task) });
    }
  }
  // Attributed runs claim their dispatch first, whatever the gap; then the nearest pairs.
  pairs.sort((a, b) => Number(b.known) - Number(a.known) || a.gap - b.gap || a.run - b.run);
  const out = new Map<number, ReviewDispatch>();
  const used = new Set<ReviewDispatch>();
  for (const p of pairs) {
    if (out.has(p.run) || used.has(p.d)) continue;
    out.set(p.run, p.d);
    used.add(p.d);
  }
  return out;
}

/** A factory PR's task: its `Factory-Task:` trailer, else its `[factory] <task>: port <Class>` title. */
export function taskFromPr(pr: { title?: unknown; body?: unknown }): string | null {
  const trailer = parsePrTrailers(typeof pr.body === 'string' ? pr.body : null).task_id;
  if (trailer) return trailer;
  const m = /^\[factory\] (\S+): port \S+$/.exec(typeof pr.title === 'string' ? pr.title : '');
  return m && isTaskId(m[1]) ? m[1] : null;
}

export const isDrill = (task: string | null): boolean => task !== null && task.startsWith('drill/');

export function workflowOfPath(path: unknown): AgentWorkflow | null {
  const m = /^\.github\/workflows\/(implement|repair|review)\.lock\.yml$/.exec(typeof path === 'string' ? path : '');
  return m ? (m[1] as AgentWorkflow) : null;
}

/** The PR/issue numbers a run's items point at, most telling first (PRs it created or pushed to). */
export function referencedNumbers(items: readonly OutcomeItem[]): { kind: 'pull' | 'issues'; number: number }[] {
  const rank = (i: OutcomeItem): number => (i.type === 'create_pull_request' ? 0 : i.type === 'push_to_pull_request_branch' ? 1 : 2);
  const out: { kind: 'pull' | 'issues'; number: number }[] = [];
  const seen = new Set<string>();
  const sorted = [...items].sort((a, b) => rank(a) - rank(b));
  for (const kindWanted of ['pull', 'issues'] as const) {
    for (const i of sorted) {
      const m = /\/(pull|issues)\/([1-9][0-9]{0,9})(?:#|$)/.exec(i.object_url ?? '');
      if (!m || m[1] !== kindWanted || seen.has(m[2]!)) continue;
      seen.add(m[2]!);
      out.push({ kind: kindWanted, number: Number(m[2]) });
    }
  }
  return out;
}

// ---------------------------------------------------------------- gh-aw output → items

/**
 * Normalizes one `gh aw outcomes <run> --json` result into items. Throws if it isn't for this run
 * or an item has a value outside gh-aw's enums. Object URLs outside this repo's PR/issue URL form
 * become null (counted in `dropped_urls`), so a surprising URL never reaches the audit log.
 */
export function itemsFromGhAw(raw: unknown, runId: number, repo: string): { items: OutcomeItem[]; dropped_urls: number } {
  const o = raw as { run_id?: unknown; items?: unknown } | null;
  if (o === null || typeof o !== 'object' || Array.isArray(o)) throw new Error('outcomes output is not an object');
  if (o.run_id !== runId) throw new Error(`outcomes output is for run ${String(o.run_id)}, not ${runId}`);
  if (!Array.isArray(o.items)) throw new Error('outcomes output has no items array');
  if (o.items.length > MAX_ITEMS_PER_RUN) throw new Error(`run has more than ${MAX_ITEMS_PER_RUN} items`);
  const url = objectUrlPattern(repo);
  let dropped = 0;
  const items = o.items.map((it: unknown, n: number): OutcomeItem => {
    const i = (it ?? {}) as Record<string, unknown>;
    if (typeof i.type !== 'string' || !ITEM_TYPE.test(i.type)) throw new Error(`item ${n}: bad type`);
    if (!(OUTCOME_STATUSES as readonly unknown[]).includes(i.outcome_status)) throw new Error(`item ${n}: bad outcome_status ${String(i.outcome_status)}`);
    if (!(EVIDENCE_STRENGTHS as readonly unknown[]).includes(i.evidence_strength)) throw new Error(`item ${n}: bad evidence_strength ${String(i.evidence_strength)}`);
    let objectUrl: string | null = null;
    if (typeof i.object_url === 'string' && i.object_url !== '') {
      if (url.test(i.object_url)) objectUrl = i.object_url;
      else dropped++;
    }
    return {
      type: i.type,
      object_url: objectUrl,
      outcome_status: i.outcome_status as OutcomeStatus,
      evidence_strength: i.evidence_strength as EvidenceStrength,
      zero_touch: typeof i.zero_touch === 'boolean' ? i.zero_touch : null,
    };
  });
  return { items, dropped_urls: dropped };
}

// ---------------------------------------------------------------- run selection

/** A completed agent run as listed from the REST API. */
export interface ListedRun {
  run_id: number;
  workflow: AgentWorkflow;
  title: string;
  created_at: string;
  conclusion: string;
}

/**
 * What started this collection:
 *   - `sweep` (schedule, workflow_dispatch, push): the daily backstop;
 *   - `pr` (pull_request_target closed, agent PRs only): that PR's outcome just became final;
 *   - `run` (workflow_run completed of implement/repair/review): that run's outputs just appeared.
 */
export type Trigger = { kind: 'sweep' } | { kind: 'pr'; pr: number; task: string | null } | { kind: 'run'; run_id: number };
export type SnapshotMode = 'full' | 'incremental' | 'targeted';
export const SNAPSHOT_MODES: readonly SnapshotMode[] = ['full', 'incremental', 'targeted'];

const hasOpenItem = (prev: OutcomeRun): boolean => prev.items.some((i) => i.outcome_status === 'pending' || i.outcome_status === 'unknown');
const isRecent = (run: ListedRun, now: Date): boolean => now.getTime() - Date.parse(run.created_at) < REEVALUATE_DAYS * DAY_MS;

/** Whether a run is one a targeted trigger names: the run itself, or a run of that PR. */
export function isTarget(run: ListedRun, prev: OutcomeRun | undefined, trigger: Trigger): boolean {
  if (trigger.kind === 'run') return run.run_id === trigger.run_id;
  if (trigger.kind !== 'pr') return false;
  const ref = new RegExp(`/(pull|issues)/${trigger.pr}(#|$)`);
  if (prev?.items.some((i) => i.object_url !== null && ref.test(i.object_url))) return true;
  const task = taskFromTitle(run.title) ?? prev?.task ?? null;
  return trigger.task !== null && task === trigger.task && (run.workflow === 'implement' || run.workflow === 'repair');
}

/**
 * Why a run is (re)evaluated, or null to carry its previous record over unchanged.
 *   sweep:    new, previously failed (stale/error), any pending/unknown item, or created < 14 days ago;
 *   targeted: the target(s), plus new, previously failed, and runs created < 14 days ago that still
 *             have a pending/unknown item ("targets + recent open"). A newer queued run replaces an
 *             older pending one in the concurrency group, so a dropped trigger's run is still picked
 *             up by the next targeted run (it is still pending/unknown), and the daily sweep covers
 *             anything older.
 */
export function evaluationReason(run: ListedRun, prev: OutcomeRun | undefined, now: Date, full: boolean, trigger: Trigger = { kind: 'sweep' }): string | null {
  if (full) return 'full';
  if (trigger.kind !== 'sweep' && isTarget(run, prev, trigger)) return 'target';
  if (!prev) return 'new';
  if (prev.eval !== 'ok') return `previous_${prev.eval}`;
  if (trigger.kind === 'sweep') {
    if (hasOpenItem(prev)) return 'pending_or_unknown';
    if (isRecent(run, now)) return 'recent';
    return null;
  }
  return hasOpenItem(prev) && isRecent(run, now) ? 'recent_pending_or_unknown' : null;
}

export interface Selection {
  mode: SnapshotMode;
  evaluate: ListedRun[];
  carry: ListedRun[];
}

/** No previous snapshot, or `full`, evaluates everything (the backfill), whatever the trigger. */
export function selectRuns(listed: readonly ListedRun[], previous: ReadonlyMap<number, OutcomeRun> | null, now: Date, full: boolean, trigger: Trigger = { kind: 'sweep' }): Selection {
  const all = full || previous === null;
  const evaluate: ListedRun[] = [];
  const carry: ListedRun[] = [];
  for (const run of listed) {
    if (evaluationReason(run, previous?.get(run.run_id), now, all, trigger) !== null) evaluate.push(run);
    else carry.push(run);
  }
  return { mode: all ? 'full' : trigger.kind === 'sweep' ? 'incremental' : 'targeted', evaluate, carry };
}

/** One run's evaluation result: items, or the error that stopped it. */
export type EvalResult = { ok: true; items: OutcomeItem[] } | { ok: false; error: string };

/**
 * The run's record: freshly evaluated (`ok`), its previous items kept (`stale`, when this
 * evaluation failed), or none (`error`). A carried-over run (no result) keeps its previous record.
 * Never dropped.
 */
export function runRecord(run: ListedRun, prev: OutcomeRun | undefined, result: EvalResult | undefined, aic: number | null | undefined, task: string | null, evaluatedAt: string, diagnosis?: Diagnosis | null): OutcomeRun {
  const base = {
    run_id: run.run_id,
    workflow: run.workflow,
    task,
    drill: isDrill(task),
    created_at: run.created_at,
    aic: aic ?? prev?.aic ?? null,
    conclusion: run.conclusion,
    diagnosis: diagnosis ?? prev?.diagnosis ?? null,
  };
  if (result === undefined) {
    if (!prev) return { ...base, eval: 'error', evaluated_at: null, items: [] };
    return { ...base, eval: prev.eval, evaluated_at: prev.evaluated_at, items: prev.items };
  }
  if (result.ok) return { ...base, eval: 'ok', evaluated_at: evaluatedAt, items: result.items };
  if (prev && prev.evaluated_at !== null) return { ...base, eval: 'stale', evaluated_at: prev.evaluated_at, items: prev.items };
  return { ...base, eval: 'error', evaluated_at: null, items: [] };
}

export function summarize(runs: readonly OutcomeRun[]): OutcomesSummary {
  const s: OutcomesSummary = { runs: runs.length, items: 0, accepted: 0, rejected: 0, ignored: 0, pending: 0, unknown: 0, other: 0, zero_touch: 0, eval_stale: 0, eval_error: 0, aic: 0 };
  let aic = 0;
  for (const r of runs) {
    if (r.eval === 'stale') s.eval_stale++;
    if (r.eval === 'error') s.eval_error++;
    if (r.aic !== null) aic += r.aic;
    for (const i of r.items) {
      s.items++;
      const st = i.outcome_status;
      if (st === 'accepted' || st === 'rejected' || st === 'ignored' || st === 'pending' || st === 'unknown') s[st]++;
      else s.other++;
      if (i.zero_touch === true) s.zero_touch++;
    }
  }
  s.aic = round6(aic);
  return s;
}

export function buildSnapshot(repo: string, now: Date, mode: SnapshotMode, runs: OutcomeRun[]): OutcomesSnapshot {
  const sorted = [...runs].sort((a, b) => b.run_id - a.run_id);
  return { version: SNAPSHOT_VERSION, repo, gh_aw_version: GH_AW_VERSION, evaluated_at: isoSeconds(now), mode, runs: sorted, summary: summarize(sorted) };
}

// ---------------------------------------------------------------- strict validation

export class OutcomesInvalid extends Error {}

const fail = (msg: string): never => {
  throw new OutcomesInvalid(msg);
};
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
function exact(v: unknown, keys: readonly string[], at: string): Record<string, unknown> {
  if (!isObj(v)) return fail(`${at}: not an object`);
  const got = Object.keys(v).sort().join(',');
  if (got !== [...keys].sort().join(',')) fail(`${at}: keys are [${got}], expected [${[...keys].sort().join(',')}]`);
  return v;
}
const oneOf = (v: unknown, values: readonly string[], at: string): string => (typeof v === 'string' && values.includes(v) ? v : fail(`${at}: ${String(v)} is not one of ${values.join('|')}`));
const ts = (v: unknown, at: string): string => (typeof v === 'string' && TIMESTAMP.test(v) && Number.isFinite(Date.parse(v)) ? v : fail(`${at}: not a UTC second timestamp`));
const count = (v: unknown, at: string): number => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : fail(`${at}: not a count`));
const aicValue = (v: unknown, at: string): number | null => (v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0) ? v : fail(`${at}: aic must be a finite number >= 0 or null`));

const ITEM_KEYS = ['type', 'object_url', 'outcome_status', 'evidence_strength', 'zero_touch'];
/** Run records before `diagnosis` existed (read only from the audit log, as diagnosis null). */
const LEGACY_RUN_KEYS = ['run_id', 'workflow', 'task', 'drill', 'created_at', 'aic', 'conclusion', 'eval', 'evaluated_at', 'items'];
const RUN_KEYS = [...LEGACY_RUN_KEYS, 'diagnosis'];
const DIAGNOSIS_KEYS = ['codes', 'severity'];

function validateDiagnosis(v: unknown, at: string): Diagnosis | null {
  if (v === null) return null;
  const d = exact(v, DIAGNOSIS_KEYS, at);
  if (!Array.isArray(d.codes) || d.codes.length > MAX_DIAGNOSIS_CODES) fail(`${at}.codes: not an array of at most ${MAX_DIAGNOSIS_CODES}`);
  const codes = d.codes as unknown[];
  codes.forEach((c, i) => {
    if (typeof c !== 'string' || !DIAGNOSIS_CODE.test(c)) fail(`${at}.codes[${i}]: not a snake_case code`);
  });
  if (new Set(codes).size !== codes.length) fail(`${at}.codes: duplicates`);
  const severity = d.severity === null ? null : (oneOf(d.severity, SEVERITIES, `${at}.severity`) as Severity);
  return { codes: codes as string[], severity };
}
const SUMMARY_KEYS = ['runs', 'items', 'accepted', 'rejected', 'ignored', 'pending', 'unknown', 'other', 'zero_touch', 'eval_stale', 'eval_error', 'aic'];
const SNAPSHOT_KEYS = ['version', 'repo', 'gh_aw_version', 'evaluated_at', 'mode', 'runs', 'summary'];

/** Strictly validates run records (exact keys, enums, ids, URLs of this repo, caps). */
export function validateRuns(value: unknown, repo: string, opts: { legacy?: boolean } = {}): OutcomeRun[] {
  if (!Array.isArray(value)) return fail('runs: not an array');
  if (value.length > MAX_RUNS) fail(`runs: more than ${MAX_RUNS}`);
  const url = objectUrlPattern(repo);
  const seen = new Set<number>();
  let total = 0;
  return value.map((rv, n) => {
    const at = `runs[${n}]`;
    const legacy = opts.legacy === true && isObj(rv) && !('diagnosis' in rv);
    const r = exact(rv, legacy ? LEGACY_RUN_KEYS : RUN_KEYS, at);
    if (typeof r.run_id !== 'number' || !Number.isSafeInteger(r.run_id) || r.run_id <= 0) fail(`${at}.run_id: not a positive integer`);
    const id = r.run_id as number;
    if (seen.has(id)) fail(`${at}: duplicate run ${id}`);
    seen.add(id);
    const workflow = oneOf(r.workflow, AGENT_WORKFLOWS, `${at}.workflow`) as AgentWorkflow;
    if (r.task !== null && !isTaskId(r.task)) fail(`${at}.task: not a task id`);
    const task = r.task as string | null;
    if (r.drill !== isDrill(task)) fail(`${at}.drill: must be true exactly for drill/* tasks`);
    const ev = oneOf(r.eval, EVAL_STATES, `${at}.eval`) as EvalState;
    const evaluatedAt = r.evaluated_at === null ? null : ts(r.evaluated_at, `${at}.evaluated_at`);
    if ((ev === 'error') !== (evaluatedAt === null)) fail(`${at}.evaluated_at: null exactly when eval is error`);
    if (!Array.isArray(r.items)) fail(`${at}.items: not an array`);
    const rawItems = r.items as unknown[];
    if (rawItems.length > MAX_ITEMS_PER_RUN) fail(`${at}.items: more than ${MAX_ITEMS_PER_RUN}`);
    if (ev === 'error' && rawItems.length > 0) fail(`${at}.items: must be empty when eval is error`);
    total += rawItems.length;
    if (total > MAX_ITEMS) fail(`items: more than ${MAX_ITEMS}`);
    const items = rawItems.map((iv, k): OutcomeItem => {
      const iat = `${at}.items[${k}]`;
      const i = exact(iv, ITEM_KEYS, iat);
      if (typeof i.type !== 'string' || !ITEM_TYPE.test(i.type)) fail(`${iat}.type: not a snake_case type`);
      if (i.object_url !== null && (typeof i.object_url !== 'string' || !url.test(i.object_url))) fail(`${iat}.object_url: not a PR/issue URL of ${repo}`);
      if (i.zero_touch !== null && typeof i.zero_touch !== 'boolean') fail(`${iat}.zero_touch: not a boolean or null`);
      return {
        type: i.type as string,
        object_url: i.object_url as string | null,
        outcome_status: oneOf(i.outcome_status, OUTCOME_STATUSES, `${iat}.outcome_status`) as OutcomeStatus,
        evidence_strength: oneOf(i.evidence_strength, EVIDENCE_STRENGTHS, `${iat}.evidence_strength`) as EvidenceStrength,
        zero_touch: i.zero_touch as boolean | null,
      };
    });
    return {
      run_id: id,
      workflow,
      task,
      drill: r.drill as boolean,
      created_at: ts(r.created_at, `${at}.created_at`),
      aic: aicValue(r.aic, `${at}.aic`),
      conclusion: oneOf(r.conclusion, RUN_CONCLUSIONS, `${at}.conclusion`),
      eval: ev,
      evaluated_at: evaluatedAt,
      items,
      diagnosis: legacy ? null : validateDiagnosis(r.diagnosis, `${at}.diagnosis`),
    };
  });
}

/**
 * Strictly validates an `outcomes.json` snapshot: exact keys everywhere, gh-aw's enums, numeric
 * run ids, task ids or null, this repo's PR/issue URLs or null, aic ≥ 0 or null, caps on runs,
 * items and size, and a summary that matches the runs.
 */
export function validateSnapshot(text: string, repo: string): OutcomesSnapshot {
  if (Buffer.byteLength(text, 'utf8') > MAX_SNAPSHOT_BYTES) fail(`snapshot larger than ${MAX_SNAPSHOT_BYTES} bytes`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail('snapshot is not JSON');
  }
  const s = exact(raw, SNAPSHOT_KEYS, 'snapshot');
  if (s.version !== SNAPSHOT_VERSION) fail('snapshot.version: not 1');
  if (s.repo !== repo) fail(`snapshot.repo: not ${repo}`);
  if (s.gh_aw_version !== GH_AW_VERSION) fail(`snapshot.gh_aw_version: not ${GH_AW_VERSION}`);
  const evaluatedAt = ts(s.evaluated_at, 'snapshot.evaluated_at');
  const mode = oneOf(s.mode, SNAPSHOT_MODES, 'snapshot.mode') as SnapshotMode;
  const runs = validateRuns(s.runs, repo);
  const sum = exact(s.summary, SUMMARY_KEYS, 'summary');
  for (const k of SUMMARY_KEYS) if (k !== 'aic') count(sum[k], `summary.${k}`);
  aicValue(sum.aic, 'summary.aic');
  const want = summarize(runs);
  if (canonicalize(want as unknown as JsonObject) !== canonicalize(sum as JsonObject)) fail('summary: does not match the runs');
  return { version: SNAPSHOT_VERSION, repo, gh_aw_version: GH_AW_VERSION, evaluated_at: evaluatedAt, mode, runs, summary: want };
}

// ---------------------------------------------------------------- controller ingestion

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (isObj(v) ? v : {});

/** Why an outcomes workflow run may not be ingested, or null if it may. */
export function outcomesRunIneligible(run: unknown, repo: string, now: Date): string | null {
  const r = rec(run);
  if (typeof r.id !== 'number' || !Number.isSafeInteger(r.id) || r.id <= 0) return 'no_run_id';
  if (typeof r.run_attempt !== 'number' || !Number.isInteger(r.run_attempt) || r.run_attempt < 1 || r.run_attempt > 10) return 'bad_attempt';
  if (r.status !== 'completed' || r.conclusion !== 'success') return 'not_successful';
  if (r.path !== OUTCOMES_WORKFLOW_PATH) return 'wrong_workflow_path';
  if (rec(r.repository).full_name !== repo || rec(r.head_repository).full_name !== repo) return 'wrong_repo';
  if (!(OUTCOMES_EVENTS as readonly unknown[]).includes(r.event)) return 'wrong_event';
  // A pull_request_target run's head_branch is the PR's branch; it still ran main's workflow.
  if (r.event !== 'pull_request_target' && r.head_branch !== 'main') return 'wrong_branch';
  const updated = typeof r.updated_at === 'string' ? Date.parse(r.updated_at) : NaN;
  if (!Number.isFinite(updated) || now.getTime() - updated > INGEST_MAX_AGE_HOURS * 3_600_000) return 'too_old';
  return null;
}

export const outcomesSourceIds = (runId: number, attempt: number): string[] => [`outcomes_run:${runId}`, `attempt:${attempt}`];

/** The `outcomes_snapshot` audit payload (besides the common fields). */
export function outcomesFields(snapshot: OutcomesSnapshot, sourceRunId: number, sourceAttempt: number): JsonObject {
  return {
    source_run_id: sourceRunId,
    source_run_attempt: sourceAttempt,
    gh_aw_version: snapshot.gh_aw_version,
    evaluated_at: snapshot.evaluated_at,
    mode: snapshot.mode,
    runs: snapshot.runs as unknown as JsonObject[],
    summary: snapshot.summary as unknown as JsonObject,
  };
}

/**
 * Content hash of the runs, without the volatile per-run `evaluated_at` (the snapshot's own
 * `evaluated_at` and source run id/attempt aren't part of `runs`). Equal hash = same outcomes.
 */
export function runsHash(runs: readonly OutcomeRun[]): string {
  const stable = [...runs].sort((a, b) => b.run_id - a.run_id).map(({ evaluated_at: _volatile, ...rest }) => rest);
  return `sha256:${sha256Hex(canonicalize(stable as unknown as JsonObject[]))}`;
}

/** The newest recorded snapshot's source run id and runs hash, or null (none in the loaded window, or unreadable). */
export function latestSnapshotHash(audit: AuditLog, repo: string): { run_id: number; hash: string } | null {
  const e = audit.newestOfType(OUTCOMES_EVENT);
  if (!e || typeof e.payload.source_run_id !== 'number') return null;
  try {
    return { run_id: e.payload.source_run_id, hash: runsHash(validateRuns(e.payload.runs, repo, { legacy: true })) };
  } catch {
    return null;
  }
}

export type IngestResult =
  | { status: 'ingested'; run_id: number; runs: number; items: number }
  | { status: 'unchanged'; run_id: number; same_as: number }
  | { status: 'none' }
  | { status: 'duplicate'; run_id: number };

/** Outcomes runs listed per poll: newest-created first, at most this many pages of 100. */
export const INGEST_LIST_PAGES = 3;

/** Newest evaluation first: completion time, then start time, then attempt, then id. */
export function newestFirst(a: Rec, b: Rec): number {
  const t = (v: unknown): number => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : 0);
  return t(b.updated_at) - t(a.updated_at) || t(b.run_started_at) - t(a.run_started_at) || (b.run_attempt as number) - (a.run_attempt as number) || (b.id as number) - (a.id as number);
}

/**
 * Whether a run's commit is on main (equal to, or an ancestor of, main's tip): one compare call.
 * Closes a ref merely *named* `main` (e.g. a tag) being used to dispatch the workflow. Any error → no.
 */
export async function commitOnMain(client: GitHubClient, repo: string, sha: unknown): Promise<boolean> {
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) return false;
  try {
    const res = await client.request('GET', `/repos/${repo}/compare/${sha}...main?per_page=1`);
    const status = rec(res.data).status;
    return status === 'identical' || status === 'ahead';
  } catch {
    return false;
  }
}

/**
 * Appends one `outcomes_snapshot` for the newest eligible outcomes run, unless already recorded
 * (or an `outcomes_checked` marker when its runs are unchanged). Reads only (run list, compare,
 * artifact list, artifact zip) plus the audit append. Throws on anything unreadable or invalid;
 * the caller logs it and goes on (fail-soft).
 *
 * No `branch=` filter on the list: a `pull_request_target` run's head_branch is the PR's branch,
 * so `outcomesRunIneligible` applies the per-event checks instead. The newest evaluation is the
 * most recently COMPLETED run (a re-run of an older collector run is newer than a higher run id).
 */
export async function ingestOutcomes(client: GitHubClient, repo: string, audit: AuditLog, now: Date, log: (line: string) => void = () => {}): Promise<IngestResult> {
  const listed: Rec[] = [];
  let next: string | null = `/repos/${repo}/actions/workflows/${OUTCOMES_WORKFLOW_FILE}/runs?status=success&per_page=100`;
  for (let page = 0; next && page < INGEST_LIST_PAGES; page++) {
    const res = await client.request('GET', next, { allowStatuses: [404] });
    if (res.status === 404) return { status: 'none' };
    const runs = (Array.isArray(rec(res.data).workflow_runs) ? (rec(res.data).workflow_runs as unknown[]) : []).map(rec);
    listed.push(...runs);
    // Older pages hold only runs created before the re-run horizon: nothing there can be fresh.
    const oldest = runs.at(-1)?.created_at;
    if (typeof oldest === 'string' && now.getTime() - Date.parse(oldest) > 30 * DAY_MS) break;
    next = res.next;
  }
  const candidates = listed.filter((r) => outcomesRunIneligible(r, repo, now) === null).sort(newestFirst);
  let run: Rec | undefined;
  for (const c of candidates) {
    const sourceIds = outcomesSourceIds(c.id as number, c.run_attempt as number);
    // Checked before anything else: recorded as a snapshot, or already found unchanged.
    if (audit.hasDedupeKey(dedupeKey(OUTCOMES_EVENT, sourceIds)) || audit.hasDedupeKey(dedupeKey(OUTCOMES_CHECKED_EVENT, sourceIds))) return { status: 'duplicate', run_id: c.id as number };
    if (c.event !== 'pull_request_target' && !(await commitOnMain(client, repo, c.head_sha))) {
      log(`outcomes: skipping run ${String(c.id)} attempt ${String(c.run_attempt)} this poll: its commit isn't on main (or couldn't be checked)`);
      continue;
    }
    run = c;
    break;
  }
  if (!run) return { status: 'none' };
  const id = run.id as number;
  const attempt = run.run_attempt as number;
  const sourceIds = outcomesSourceIds(id, attempt);

  const artifacts = (await paginate(client, `/repos/${repo}/actions/runs/${id}/artifacts?name=${OUTCOMES_ARTIFACT}&per_page=100`, (d) => (Array.isArray(rec(d).artifacts) ? (rec(d).artifacts as unknown[]) : []))).map(rec).filter((a) => a.name === OUTCOMES_ARTIFACT);
  if (artifacts.length !== 1) throw new Error(`outcomes run ${id} has ${artifacts.length} ${OUTCOMES_ARTIFACT} artifacts`);
  const a = artifacts[0]!;
  if (a.expired !== false || typeof a.id !== 'number' || !Number.isSafeInteger(a.id)) throw new Error(`outcomes run ${id}'s artifact is expired or has no id`);
  if (typeof a.size_in_bytes !== 'number' || a.size_in_bytes > MAX_OUTCOMES_ZIP_BYTES) throw new Error(`outcomes run ${id}'s artifact is too large`);
  const zip = await client.request('GET', `/repos/${repo}/actions/artifacts/${a.id}/zip`, { accept: 'binary' });
  if (!(zip.data instanceof Uint8Array)) throw new Error(`outcomes run ${id}'s artifact could not be downloaded`);
  const text = readZip(zip.data, [OUTCOMES_FILE], MAX_OUTCOMES_ZIP_BYTES).get(OUTCOMES_FILE);
  if (text === undefined) throw new Error(`outcomes run ${id}'s artifact has no ${OUTCOMES_FILE}`);
  const snapshot = validateSnapshot(text, repo);
  // Size guard: an unchanged snapshot isn't recorded again. Only a ~300-byte `outcomes_checked`
  // marker is, so later polls skip this run without downloading it.
  const hash = runsHash(snapshot.runs);
  const latest = latestSnapshotHash(audit, repo);
  if (latest && latest.hash === hash) {
    const checked: PendingEvent = { type: OUTCOMES_CHECKED_EVENT, source_ids: sourceIds, fields: { source_run_id: id, source_run_attempt: attempt, runs_hash: hash, same_as_run_id: latest.run_id }, dry_run: false };
    await audit.append(checked, now);
    return { status: 'unchanged', run_id: id, same_as: latest.run_id };
  }
  const pending: PendingEvent = { type: OUTCOMES_EVENT, source_ids: sourceIds, fields: outcomesFields(snapshot, id, attempt), dry_run: false };
  const appended = await audit.append(pending, now);
  if (!appended) return { status: 'duplicate', run_id: id };
  return { status: 'ingested', run_id: id, runs: snapshot.summary.runs, items: snapshot.summary.items };
}

/** The runs of the newest `outcomes_snapshot` in a loaded audit log, or null (none, or unreadable). */
export function previousRuns(audit: AuditLog, repo: string): Map<number, OutcomeRun> | null {
  const e = audit.newestOfType(OUTCOMES_EVENT);
  if (!e) return null;
  try {
    return new Map(validateRuns(e.payload.runs, repo, { legacy: true }).map((r) => [r.run_id, r]));
  } catch {
    return null;
  }
}

/** Task lookup through a PR (trailer or title) or a task issue (marker). Null if neither names one. */
export async function taskFromReference(client: GitHubClient, repo: string, ref: { kind: 'pull' | 'issues'; number: number }): Promise<string | null> {
  if (ref.kind === 'pull') {
    const res = await client.request('GET', `/repos/${repo}/pulls/${ref.number}`, { allowStatuses: [404] });
    return res.status === 404 ? null : taskFromPr(rec(res.data));
  }
  const res = await client.request('GET', `/repos/${repo}/issues/${ref.number}`, { allowStatuses: [404] });
  if (res.status === 404) return null;
  const d = rec(res.data);
  // An "issue" URL can be a PR: then its trailer or title decides.
  if (d.pull_request !== undefined) return taskFromPr(d);
  return parseTaskMarker(typeof d.body === 'string' ? d.body : null).task_id;
}
