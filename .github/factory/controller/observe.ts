// Turns a snapshot into observed fact events (pr_opened, check_result, queued,
// dequeued, merged, human_action). Pure. Each fact carries deterministic
// source IDs, so the same fact always gets the same dedupe_key.
//
// Only facts whose own GitHub timestamp is inside the observation window are
// emitted. The window (24 h) is shorter than the loaded audit history, so a
// fact that was already recorded is always found by the dedupe check.

import type { JsonObject, PendingEvent, Snapshot } from './types.ts';

export const OBSERVE_WINDOW_HOURS = 24;

const REVIEW_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED']);

interface Fact {
  at: string;
  event: PendingEvent;
}

export function observe(s: Snapshot, now: Date, windowHours = OBSERVE_WINDOW_HOURS): PendingEvent[] {
  const start = now.getTime() - windowHours * 3_600_000;
  const inWindow = (ts: string | null): ts is string => {
    if (!ts) return false;
    const t = Date.parse(ts);
    return Number.isFinite(t) && t >= start && t <= now.getTime();
  };
  const facts: Fact[] = [];
  const add = (at: string, type: string, source_ids: string[], fields: JsonObject): void => {
    facts.push({ at, event: { type, source_ids, fields } });
  };

  for (const pr of s.pulls) {
    if (inWindow(pr.created_at)) {
      add(pr.created_at, 'pr_opened', [pr.node_id], {
        pr: pr.number,
        head_sha: pr.head_sha,
        author: pr.author,
        opened_at: pr.created_at,
      });
    }
    if (pr.state === 'merged' && inWindow(pr.merged_at)) {
      add(pr.merged_at, 'merged', [pr.node_id], {
        pr: pr.number,
        merge_commit_sha: pr.merge_commit_sha,
        merged_at: pr.merged_at,
        task: pr.task_id,
      });
    }
    for (const q of pr.merge_queue_events) {
      if (!inWindow(q.created_at)) continue;
      add(q.created_at, q.kind, [q.node_id], { pr: pr.number, actor: q.actor, at: q.created_at });
    }
    for (const r of pr.reviews) {
      if (r.author_is_bot || !r.author || !REVIEW_STATES.has(r.state) || !inWindow(r.submitted_at)) continue;
      add(r.submitted_at, 'human_action', [r.node_id], {
        action: 'review',
        pr: pr.number,
        reviewer: r.author,
        state: r.state,
        submitted_at: r.submitted_at,
      });
    }
  }

  for (const run of s.check_runs) {
    if (run.status !== 'completed' || !run.conclusion || !inWindow(run.updated_at)) continue;
    const fields: JsonObject = {
      workflow: run.workflow,
      run_id: run.run_id,
      run_attempt: run.run_attempt,
      event: run.event,
      head_sha: run.head_sha,
      prs: [...run.pull_requests].sort((a, b) => a - b),
      conclusion: run.conclusion,
      completed_at: run.updated_at,
    };
    if (run.heldout_seed !== null) fields.heldout_seed = run.heldout_seed;
    if (run.failure_signature !== null) fields.failure_signature = run.failure_signature;
    if (typeof run.full_regression === 'string') fields.full_regression = run.full_regression;
    add(run.updated_at, 'check_result', [`${run.run_id}/attempts/${run.run_attempt}`], fields);
  }

  facts.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.event.type < b.event.type ? -1 : a.event.type > b.event.type ? 1 : 0));
  return facts.map((f) => f.event);
}
