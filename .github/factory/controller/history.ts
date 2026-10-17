// Derives per-task history and today's factory spend from audit events.
// Only real (non-dry-run) events count: v1's own dry-run decisions must never
// look like work that actually happened.

import type { AuditEvent, TaskHistory } from './types.ts';
import { isTaskId } from './tasks.ts';

export interface DerivedState {
  history: Record<string, TaskHistory>;
  /**
   * Null (unknown) unless a `spend_snapshot` record for today exists: the absence
   * of `run_finished` events is not proof that nothing was spent (fail closed).
   * When known: max(newest snapshot's `aic_today`, sum of today's `run_finished`).
   */
  factory_aic_today: number | null;
}

export function deriveState(events: AuditEvent[], now: Date): DerivedState {
  const history: Record<string, TaskHistory> = {};
  const day = now.toISOString().slice(0, 10);
  let aicToday = 0;
  let snapshotToday: number | null = null;
  const entry = (task: string): TaskHistory =>
    (history[task] ??= { picked_at: null, repairs: 0, failure_signatures: [], repaired_run_ids: [], aic_spent: 0 });

  for (const e of events) {
    if (e.payload.dry_run !== false) continue;
    const task = isTaskId(e.payload.task) ? e.payload.task : null;
    switch (e.type) {
      case 'picked':
      case 'dispatched': {
        if (!task) break;
        const h = entry(task);
        if (!h.picked_at || e.timestamp < h.picked_at) h.picked_at = e.timestamp;
        break;
      }
      case 'repair_dispatched': {
        if (!task) break;
        const h = entry(task);
        h.repairs++;
        if (typeof e.payload.run_id === 'number') h.repaired_run_ids.push(e.payload.run_id);
        if (typeof e.payload.failure_signature === 'string') h.failure_signatures.push(e.payload.failure_signature);
        break;
      }
      case 'run_finished': {
        const aic = e.payload.aic;
        if (typeof aic !== 'number' || !Number.isFinite(aic) || aic < 0) break;
        if (task) entry(task).aic_spent += aic;
        if (e.timestamp.startsWith(day)) aicToday += aic;
        break;
      }
      case 'spend_snapshot': {
        const aic = e.payload.aic_today;
        if (e.payload.day !== day || !e.timestamp.startsWith(day)) break;
        if (typeof aic !== 'number' || !Number.isFinite(aic) || aic < 0) break;
        snapshotToday = aic; // events are in log order: the newest wins
        break;
      }
      default:
        break;
    }
  }
  return { history, factory_aic_today: snapshotToday === null ? null : Math.max(snapshotToday, aicToday) };
}
