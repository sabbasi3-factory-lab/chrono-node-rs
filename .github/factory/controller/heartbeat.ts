// Hourly heartbeat (DESIGN §11, cadence.yaml `heartbeat: hourly`).

import type { AuditEvent, PendingEvent } from './types.ts';

export const HEARTBEAT_MIN_AGE_MINUTES = 55;

/** `YYYY-MM-DDTHH` (UTC) — two runs in the same hour share one dedupe key. */
export function hourBucket(now: Date): string {
  return now.toISOString().slice(0, 13);
}

/** Due if there is no heartbeat in the loaded events or the newest is ≥ 55 minutes old. */
export function heartbeatDue(newest: AuditEvent | null, now: Date): boolean {
  if (!newest) return true;
  const age = now.getTime() - Date.parse(newest.timestamp);
  if (!Number.isFinite(age)) return true;
  return age >= HEARTBEAT_MIN_AGE_MINUTES * 60_000;
}

export interface HeartbeatInput {
  run_id: number;
  trigger: string;
  open_pr_count: number;
  decision_count: number;
  /** Kill switch state: true only when vars.FACTORY_ENABLED === "true". */
  factory_enabled: boolean;
}

export function heartbeatEvent(now: Date, input: HeartbeatInput): PendingEvent {
  const hour = hourBucket(now);
  return {
    type: 'heartbeat',
    source_ids: [`hour:${hour}`],
    fields: {
      hour,
      run_id: input.run_id,
      trigger: input.trigger,
      open_pr_count: input.open_pr_count,
      decision_count: input.decision_count,
      factory_enabled: input.factory_enabled,
    },
  };
}
