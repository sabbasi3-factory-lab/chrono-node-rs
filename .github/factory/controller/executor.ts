// Effect executor. Controller v1 is hard-wired to dry-run: this executor has
// no GitHub client at all, so it cannot take effects. It only logs what it
// would do. The audit log is written separately by main (the only write).

import { isRecorded } from './planner.ts';
import type { Decision, JsonObject, PendingEvent } from './types.ts';

/** Not an input, not an env var: v1 is dry-run by construction. */
export const DRY_RUN = true as const;

export function describe(d: Decision): string {
  const subject = [
    d.task ? `task=${d.task}` : '',
    d.issue !== null ? `issue=#${d.issue}` : '',
    d.pr !== null ? `pr=#${d.pr}` : '',
    d.attempt !== null ? `attempt=${d.attempt}` : '',
    d.contract_sha ? `contract=${d.contract_sha.slice(0, 12)}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  if (d.type === 'wait') return `[dry-run] wait (${d.reason}) ${subject}`.trimEnd();
  const what = d.effect === 'none' ? 'take no effect' : d.effect;
  return `[dry-run] would ${what} (${d.type}/${d.reason}) ${subject}`.trimEnd();
}

export function execute(decisions: Decision[], log: (line: string) => void): string[] {
  if (DRY_RUN !== true) throw new Error('controller v1 must run in dry-run mode');
  const lines = decisions.map(describe);
  for (const line of lines) log(line);
  return lines;
}

/** The audit event recorded for a non-wait decision (dedupe on source ids + reason + effect). */
export function decisionEvent(d: Decision): PendingEvent {
  if (!isRecorded(d)) throw new Error('wait decisions are not recorded');
  if (d.dry_run !== true) throw new Error('decision is not dry-run');
  const fields: JsonObject = { reason: d.reason, effect: d.effect };
  if (d.task !== null) fields.task = d.task;
  if (d.issue !== null) fields.issue = d.issue;
  if (d.pr !== null) fields.pr = d.pr;
  if (d.attempt !== null) fields.attempt = d.attempt;
  if (d.contract_sha !== null) fields.contract_sha = d.contract_sha;
  if (d.run_id !== null) fields.run_id = d.run_id;
  if (d.failure_signature !== null) fields.failure_signature = d.failure_signature;
  // The reason and effect are part of the dedupe identity: a changed reason for
  // the same subject (missing_task_marker → contract_missing) is a new fact,
  // while an identical retry still dedupes.
  return { type: d.type, source_ids: [...d.source_ids, `reason:${d.reason}`, `effect:${d.effect}`], fields };
}
