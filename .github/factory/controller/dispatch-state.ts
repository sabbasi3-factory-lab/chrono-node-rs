// What the controller's dispatching is doing right now, for the control room: running, waiting
// (ready work held by a limit or by unmerged dependencies), paused (a global gate: kill switch,
// spend, Actions load) or idle (nothing ready). main records a `dispatch_state` audit event when
// it changes, and re-records it daily so it never leaves the audit window; `since` carries over,
// backfilled from evidence where there is some (a spend pause: when the first unreadable run ended).

import { inFlightTasks, killSwitchEnabled, LABEL_NEEDS_HUMAN, LABEL_PICKED, LABEL_READY } from './planner.ts';
import type { Decision, PlannerEnv, Snapshot } from './types.ts';

export type DispatchState = 'running' | 'waiting' | 'paused' | 'idle';
/** The planner's global dispatch gates (planner.ts globalGate). */
export const PAUSE_REASONS = ['kill_switch', 'budget_unknown', 'budget_pause', 'busy_jobs_unknown', 'actions_busy'] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];
/** The planner's per-task capacity gates. */
export const LIMIT_REASONS = ['wip_full', 'human_queue_full', 'core_area_busy', 'area_locked'] as const;

/** Re-record an unchanged state after this long, so the newest one stays in the audit window. */
export const REFRESH_MS = 24 * 3600_000;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export interface DispatchStatus {
  state: DispatchState;
  /** The gate (paused), `limits` or `deps` (waiting), or `none`. */
  reason: PauseReason | 'limits' | 'deps' | 'none';
  ready: number;
  in_flight: number;
  spend_known: boolean;
  /** Today's AI runs whose spend couldn't be read (0 when spend is known). */
  unreadable_runs: number;
  /** When this state and reason began (ISO seconds), carried across re-records. */
  since: string;
  /**
   * How `since` is known: `evidence` (backfilled from the cause, e.g. when the first unreadable run
   * ended), `transition` (seen changing between two polls) or `first_record` (the state was already
   * in place when first recorded: `since` is only when it was recorded).
   */
  since_source: SinceSource;
}

export type SinceSource = 'evidence' | 'transition' | 'first_record';
const SOURCES: readonly string[] = ['evidence', 'transition', 'first_record'];

/** The newest recorded dispatch_state event, as main reads it from the audit log. */
export interface PrevState {
  timestamp: string;
  payload: Record<string, unknown>;
}

const STARTS = new Set(['dispatched', 'repair_dispatched', 'review_dispatched']);
const iso = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

export function dispatchStatus(
  decisions: readonly Decision[], s: Snapshot, env: PlannerEnv, spendKnown: boolean, unreadable: number, prev: PrevState | null, now: Date,
  unreadableSince: string | null = null,
): DispatchStatus {
  const inFlight = inFlightTasks(s).size;
  const ready = s.issues.filter((i) => i.labels.includes(LABEL_READY) && !i.labels.includes(LABEL_PICKED) && !i.labels.includes(LABEL_NEEDS_HUMAN)).length;
  const waits = new Set(decisions.filter((d) => d.type === 'wait').map((d) => d.reason as string));
  let state: DispatchState;
  let reason: DispatchStatus['reason'];
  const gate = PAUSE_REASONS.find((r) => waits.has(r));
  if (!killSwitchEnabled(env)) [state, reason] = ['paused', 'kill_switch'];
  else if (gate) [state, reason] = ['paused', gate];
  else if (inFlight > 0 || decisions.some((d) => STARTS.has(d.type))) [state, reason] = ['running', 'none'];
  else if (LIMIT_REASONS.some((r) => waits.has(r))) [state, reason] = ['waiting', 'limits'];
  else if (waits.has('deps_not_merged')) [state, reason] = ['waiting', 'deps'];
  else [state, reason] = ['idle', 'none'];
  const base = { state, reason, ready, in_flight: inFlight, spend_known: spendKnown, unreadable_runs: spendKnown ? 0 : unreadable };

  // Where `since` comes from, best first: evidence of the cause, a carried value, this poll.
  let since = iso(now);
  let source: SinceSource = prev ? 'transition' : 'first_record';
  const p = prev?.payload;
  if (p && p.state === state && p.reason === reason) {
    since = typeof p.since === 'string' && TIMESTAMP.test(p.since) ? p.since : prev!.timestamp;
    // Events from before since_source existed were first records.
    source = typeof p.since_source === 'string' && SOURCES.includes(p.since_source) ? (p.since_source as SinceSource) : 'first_record';
  }
  const evidence = reason === 'budget_unknown' && unreadableSince && TIMESTAMP.test(unreadableSince) && Date.parse(unreadableSince) <= now.getTime() ? unreadableSince : null;
  // Evidence only refines a first record, and only moves `since` earlier. After a seen transition the
  // start is bounded by the poll that still saw the old state (a higher gate may have masked the
  // cause), so the transition time stands.
  if (evidence && source === 'first_record' && Date.parse(evidence) <= Date.parse(since)) {
    [since, source] = [evidence, 'evidence'];
  }
  return { ...base, since, since_source: source };
}

/**
 * Whether to record the status: on a change in what the control room shows, or when the newest
 * record is a day old (so it stays in the window and `since` survives a long unchanged state).
 */
export function shouldRecord(prev: PrevState | null, next: DispatchStatus, now: Date): boolean {
  if (!prev) return true;
  const p = prev.payload;
  if (p.state !== next.state || p.reason !== next.reason || p.spend_known !== next.spend_known || p.unreadable_runs !== next.unreadable_runs) return true;
  if (p.since !== next.since || p.since_source !== next.since_source) return true; // e.g. backfilled from evidence
  const at = Date.parse(prev.timestamp);
  return !Number.isFinite(at) || now.getTime() - at >= REFRESH_MS;
}
