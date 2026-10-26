// What the controller's dispatching is doing right now, for the control room: running, waiting
// (ready work held by WIP or area limits), paused (a global gate: kill switch, spend, Actions load)
// or idle (nothing ready). main records a `dispatch_state` audit event only when it changes, so the
// event's timestamp is "since".

import { killSwitchEnabled, LABEL_PICKED, LABEL_READY } from './planner.ts';
import type { Decision, PlannerEnv, Snapshot } from './types.ts';

export type DispatchState = 'running' | 'waiting' | 'paused' | 'idle';
/** The planner's global dispatch gates (planner.ts globalGate). */
export const PAUSE_REASONS = ['kill_switch', 'budget_unknown', 'budget_pause', 'busy_jobs_unknown', 'actions_busy'] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];

export interface DispatchStatus {
  state: DispatchState;
  /** The gate (paused), `limits` (waiting), or `none`. */
  reason: PauseReason | 'limits' | 'none';
  ready: number;
  in_flight: number;
  spend_known: boolean;
  /** Today's AI runs whose spend couldn't be read (0 when spend is known). */
  unreadable_runs: number;
}

const STARTS = new Set(['dispatched', 'repair_dispatched', 'review_dispatched']);

export function dispatchStatus(decisions: readonly Decision[], s: Snapshot, env: PlannerEnv, spendKnown: boolean, unreadable: number): DispatchStatus {
  const open = s.issues; // the snapshot holds open issues only
  const inFlight = open.filter((i) => i.labels.includes(LABEL_PICKED)).length;
  const ready = open.filter((i) => i.labels.includes(LABEL_READY) && !i.labels.includes(LABEL_PICKED)).length;
  const base = { ready, in_flight: inFlight, spend_known: spendKnown, unreadable_runs: spendKnown ? 0 : unreadable };
  if (!killSwitchEnabled(env)) return { state: 'paused', reason: 'kill_switch', ...base };
  const gate = decisions.find((d) => d.type === 'wait' && (PAUSE_REASONS as readonly string[]).includes(d.reason));
  if (gate) return { state: 'paused', reason: gate.reason as PauseReason, ...base };
  if (inFlight > 0 || decisions.some((d) => STARTS.has(d.type))) return { state: 'running', reason: 'none', ...base };
  if (ready > 0) return { state: 'waiting', reason: 'limits', ...base };
  return { state: 'idle', reason: 'none', ...base };
}

/** Whether the status differs from the last recorded one in what the control room shows. */
export function stateChanged(prev: Record<string, unknown> | null, next: DispatchStatus): boolean {
  if (!prev) return true;
  return prev.state !== next.state || prev.reason !== next.reason || prev.spend_known !== next.spend_known || prev.unreadable_runs !== next.unreadable_runs;
}
