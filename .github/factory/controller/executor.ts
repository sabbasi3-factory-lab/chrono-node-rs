// Effect executor (DESIGN §7).
//
// Dry-run (the default, and always unless FACTORY_ENABLED is exactly "true"): no effects at all,
// it only logs what it would do.
//
// Live (FACTORY_ENABLED=true): it takes exactly these effects, and nothing else. The client's
// allowlist (github.ts assertAllowedRequest, mode 'live') enforces the same list independently.
//   dispatch_workflow:implement → add `factory:picked` to the task issue, then dispatch
//                                 implement.lock.yml on main with {task, issue, attempt, contract_sha}
//   label:needs-human           → add `needs-human` to the PR and/or issue, then one templated comment
//   label:blocked               → add `blocked`, then one templated comment
//   label:stale-contract        → add `stale-contract`, then one templated comment
//   enqueue_merge               → add the PR to the merge queue (GraphQL enqueuePullRequest); only
//                                 for green auto-tier agent PRs (planner autoMergeBlocker). If
//                                 GitHub refuses, the PR is handed to a person instead
//                                 (needs_human/enqueue_failed). GitHub then merges it once the
//                                 merge-group checks pass; `queued` and `merged` are observed facts.
//   dispatch_workflow:repair    → no repair workflow exists yet: escalated instead to
//                                 needs_human/repair_unavailable (label + comment)
//   alert:owner, pause_dispatch, none → no GitHub effect; recorded in the audit log only
// It never merges directly (only the merge queue merges), closes, removes a label, adds
// `factory:ready`, or dispatches anything else.
//
// Each decision's effect runs only if its LIVE audit event is new. Live events carry `mode:live`
// in their dedupe identity, so a decision recorded while the switch was off (dry-run) doesn't
// count as done. Every event is validated before any effect.
// - Dispatch: label the issue `factory:picked`, dispatch, then record. If anything fails after the
//   label, the planner sees a picked issue without a pick time and hands it to a human
//   (needs_human/pick_time_unknown) instead of dispatching it twice.
// - Hand-off (label + comment): record the decision first, then add the label(s), then post one
//   comment carrying a hidden marker with the decision's dedupe key, then record `handoff_done`.
//   Every live run first finishes any recorded hand-off without `handoff_done` (the planner skips
//   human-held tasks, so it wouldn't retry them): labels are re-added (idempotent) and the comment
//   is posted only if no comment with its marker exists yet.

import { dedupeKey } from './audit.ts';
import { COMMENT_MARKER, ENQUEUE_MUTATION, IMPLEMENT_WORKFLOW, MAX_COMMENT_LENGTH, paginate } from './github.ts';
import { isRecorded, LABEL_NEEDS_HUMAN, LABEL_PICKED } from './planner.ts';
import type { AuditEvent, Decision, GitHubClient, JsonObject, PendingEvent, PlannerEnv, ReasonCode } from './types.ts';

/** Live only when FACTORY_ENABLED is exactly "true"; anything else (unset, "TRUE", "1") is dry-run. */
export function isLive(env: PlannerEnv): boolean {
  return env.FACTORY_ENABLED === 'true';
}

export function describe(d: Decision, live = false): string {
  const subject = [
    d.task ? `task=${d.task}` : '',
    d.issue !== null ? `issue=#${d.issue}` : '',
    d.pr !== null ? `pr=#${d.pr}` : '',
    d.attempt !== null ? `attempt=${d.attempt}` : '',
    d.contract_sha ? `contract=${d.contract_sha.slice(0, 12)}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const tag = live ? '[live]' : '[dry-run]';
  if (d.type === 'wait') return `${tag} wait (${d.reason}) ${subject}`.trimEnd();
  const what = d.effect === 'none' ? 'take no effect' : d.effect;
  return `${tag} ${live ? 'do' : 'would'} ${what} (${d.type}/${d.reason}) ${subject}`.trimEnd();
}

/** Dry-run: log only. */
export function execute(decisions: Decision[], log: (line: string) => void): string[] {
  const lines = decisions.map((d) => describe(d, false));
  for (const line of lines) log(line);
  return lines;
}

/**
 * The audit event recorded for a non-wait decision (dedupe on source ids + reason + effect, plus
 * `mode:live` for live records, so a dry-run record never stands in for a live effect).
 */
export function decisionEvent(d: Decision, live = false): PendingEvent {
  if (!isRecorded(d)) throw new Error('wait decisions are not recorded');
  if (d.dry_run !== true) throw new Error('decisions are plans (dry_run: true); the audit log records whether they ran');
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
  return { type: d.type, source_ids: [...d.source_ids, `reason:${d.reason}`, `effect:${d.effect}`, ...(live ? ['mode:live'] : [])], fields };
}

/** In live mode a repair becomes a human hand-off: there is no repair workflow yet. */
export function liveDecision(d: Decision): Decision {
  if (d.effect !== 'dispatch_workflow:repair') return d;
  return { ...d, type: 'needs_human', reason: 'repair_unavailable', effect: 'label:needs-human' };
}

const LABEL_OF: Partial<Record<Decision['effect'], string>> = {
  'label:needs-human': LABEL_NEEDS_HUMAN,
  'label:blocked': 'blocked',
  'label:stale-contract': 'stale-contract',
};

/** Fixed text per reason code. Comments carry no text from issues, PRs or agents. */
const REASON_TEXT: Partial<Record<ReasonCode, string>> = {
  gates_failed: 'The trusted `gates` check failed on this PR. Gate failures are never repaired automatically.',
  repeated_signature: 'CI failed again with the same failure signature.',
  max_repairs: 'CI is still failing after the maximum number of repairs.',
  missing_failure_signature: 'CI failed, but its failure signature could not be read from a trusted source.',
  missing_heldout_seed: 'The CI run has no trusted held-out seed.',
  task_budget_exhausted: "The task has used its AI budget.",
  task_timeout: 'The task has been in progress longer than the time limit.',
  pick_time_unknown: 'The issue is marked picked, but the audit log has no pick time for it.',
  repair_unavailable: 'CI failed. There is no repair workflow yet, so a person decides what to do.',
  merge_queue_rejected: 'This PR left the merge queue without merging (the merge-group checks failed, or it was removed). It is not re-queued automatically.',
  enqueue_failed: 'Every check passed, but GitHub refused to add this PR to the merge queue.',
  invalid_contract: "The task's contract on main can't be used.",
  missing_contract_sha: 'The PR has no `Contract-SHA:` trailer.',
  missing_task_marker: 'The issue has no valid factory task marker.',
  duplicate_task: 'Another open issue already has this task.',
  contract_missing: 'There is no contract for this task on main.',
  contract_changed: "The contract changed after this PR's `Contract-SHA:`.",
};

/** Hidden marker that ties a comment to its decision, so a retried hand-off never posts twice. */
export const decisionMarker = (key: string): string => `<!-- factory-decision: ${key} -->`;

export function commentBody(d: Pick<Decision, 'type' | 'reason'>, label: string, runUrl: string | null, key: string): string {
  const text = REASON_TEXT[d.reason] ?? 'See the audit log for details.';
  const body = [
    `${COMMENT_MARKER} · \`${d.type}\` (\`${d.reason}\`)`,
    '',
    text,
    '',
    `Labelled \`${label}\`. The controller doesn't remove labels; a person does.${runUrl ? ` Run: ${runUrl}` : ''}`,
    '',
    decisionMarker(key),
  ].join('\n');
  if (body.length > MAX_COMMENT_LENGTH) throw new Error('comment too long');
  return body;
}

export interface LiveDeps {
  client: GitHubClient;
  repo: string;
  log: (line: string) => void;
  /** True if the event's dedupe key isn't in the audit log yet. */
  isNew: (ev: PendingEvent) => boolean;
  /** Throws (before any effect) if the event can't be recorded. */
  validate: (ev: PendingEvent) => void;
  /** Records the event (dry_run: false). */
  record: (ev: PendingEvent) => Promise<void>;
  runUrl: string | null;
  /** Recorded live hand-offs that have no `handoff_done` yet (see pendingHandoffs). */
  pending?: PendingHandoff[];
}

export interface PendingHandoff {
  key: string;
  type: Decision['type'];
  reason: ReasonCode;
  effect: Decision['effect'];
  issue: number | null;
  pr: number | null;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

/** Live hand-offs in the loaded audit window that were recorded but not completed. */
export function pendingHandoffs(events: AuditEvent[]): PendingHandoff[] {
  const done = new Set<string>();
  for (const e of events) if (e.type === 'handoff_done' && typeof e.payload.decision === 'string') done.add(e.payload.decision);
  const out: PendingHandoff[] = [];
  for (const e of events) {
    const p = e.payload;
    if (p.dry_run !== false || typeof p.effect !== 'string' || !LABEL_OF[p.effect as Decision['effect']]) continue;
    const key = p.dedupe_key as string;
    if (done.has(key)) continue;
    const issue = isNum(p.issue) ? p.issue : null;
    const pr = isNum(p.pr) ? p.pr : null;
    if (issue === null && pr === null) continue;
    out.push({ key, type: e.type as Decision['type'], reason: p.reason as ReasonCode, effect: p.effect as Decision['effect'], issue, pr });
  }
  return out;
}

export const MAX_RECONCILE_PER_RUN = 20;

async function addLabel(deps: LiveDeps, number: number, label: string): Promise<void> {
  await deps.client.request('POST', `/repos/${deps.repo}/issues/${number}/labels`, { body: { labels: [label] } });
}

/** Labels (idempotent), then the comment unless one with its marker exists, then `handoff_done`. */
async function completeHandoff(deps: LiveDeps, h: PendingHandoff): Promise<void> {
  const label = LABEL_OF[h.effect]!;
  const targets = [h.pr, h.issue].filter((n): n is number => n !== null);
  for (const n of targets) await addLabel(deps, n, label);
  const marker = decisionMarker(h.key);
  const comments = await paginate(deps.client, `/repos/${deps.repo}/issues/${targets[0]}/comments?per_page=100`, (d) => (Array.isArray(d) ? d : []));
  const posted = comments.some((c) => typeof (c as { body?: unknown }).body === 'string' && (c as { body: string }).body.includes(marker));
  if (!posted) {
    await deps.client.request('POST', `/repos/${deps.repo}/issues/${targets[0]}/comments`, { body: { body: commentBody(h, label, deps.runUrl, h.key) } });
  }
  await deps.record({ type: 'handoff_done', source_ids: [`done:${h.key}`], fields: { decision: h.key, effect: h.effect } });
}

/** Live: finish pending hand-offs, then take each new decision's effect once. Returns how many ran. */
export async function executeLive(decisions: Decision[], deps: LiveDeps): Promise<number> {
  for (const h of (deps.pending ?? []).slice(0, MAX_RECONCILE_PER_RUN)) {
    deps.log(`[live] finishing hand-off ${h.type}/${h.reason}${h.issue !== null ? ` issue=#${h.issue}` : ''}${h.pr !== null ? ` pr=#${h.pr}` : ''}`);
    await completeHandoff(deps, h);
  }
  let ran = 0;
  for (const planned of decisions) {
    if (!isRecorded(planned)) {
      deps.log(describe(planned, true));
      continue;
    }
    const d = liveDecision(planned);
    const ev = decisionEvent(d, true);
    if (!deps.isNew(ev)) {
      deps.log(`[live] already done: ${d.type}/${d.reason}${d.issue !== null ? ` issue=#${d.issue}` : ''}${d.pr !== null ? ` pr=#${d.pr}` : ''}`);
      continue;
    }
    deps.validate(ev);
    deps.log(describe(d, true));
    if (d.effect === 'dispatch_workflow:implement') {
      if (d.issue === null || d.task === null || d.attempt === null || d.contract_sha === null) throw new Error('dispatch decision is missing task, issue, attempt or contract SHA');
      await addLabel(deps, d.issue, LABEL_PICKED);
      await deps.client.request('POST', `/repos/${deps.repo}/actions/workflows/${IMPLEMENT_WORKFLOW}/dispatches`, {
        body: { ref: 'main', inputs: { task: d.task, issue: String(d.issue), attempt: String(d.attempt), contract_sha: d.contract_sha } },
      });
      await deps.record(ev);
    } else if (LABEL_OF[d.effect]) {
      if (d.pr === null && d.issue === null) throw new Error(`${d.type}/${d.reason} has no issue or PR to label`);
      // Record first: if a later step fails, the next live run finishes it (pendingHandoffs).
      await deps.record(ev);
      await completeHandoff(deps, { key: dedupeKey(ev.type, ev.source_ids), type: d.type, reason: d.reason, effect: d.effect, issue: d.issue, pr: d.pr });
    } else if (d.effect === 'enqueue_merge') {
      if (d.pr === null) throw new Error('enqueue decision has no PR');
      const prId = d.source_ids[0];
      if (!prId || !/^PR_/.test(prId)) throw new Error('enqueue decision has no PR node id');
      let refused: string | null = null;
      try {
        const res = await deps.client.request('POST', '/graphql', { body: { query: ENQUEUE_MUTATION, variables: { id: prId } } });
        const body = res.data as { errors?: unknown[]; data?: { enqueuePullRequest?: { mergeQueueEntry?: { id?: unknown } } } } | null;
        if (!body || (body.errors && body.errors.length > 0) || typeof body.data?.enqueuePullRequest?.mergeQueueEntry?.id !== 'string') refused = 'GraphQL error';
      } catch (err) {
        if (!(err instanceof Error) || !/HTTP 4\d\d/.test(err.message)) throw err; // transient: fail the run, retry next poll
        refused = err.message;
      }
      if (refused !== null) {
        deps.log(`[live] enqueue refused for pr=#${d.pr} (${refused}): handing it to a person`);
        const h: Decision = { ...d, type: 'needs_human', reason: 'enqueue_failed', effect: 'label:needs-human', source_ids: [...d.source_ids, 'enqueue_failed'] };
        const hev = decisionEvent(h, true);
        deps.validate(hev);
        await deps.record(hev);
        await completeHandoff(deps, { key: dedupeKey(hev.type, hev.source_ids), type: h.type, reason: h.reason, effect: h.effect, issue: h.issue, pr: h.pr });
      }
      await deps.record(ev);
    } else if (d.effect === 'dispatch_workflow:repair') {
      throw new Error('repair dispatch is not available');
    } else {
      // alert:owner, pause_dispatch and none have no GitHub effect: the record is the effect.
      await deps.record(ev);
    }
    ran++;
  }
  return ran;
}
