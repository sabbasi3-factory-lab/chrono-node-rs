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
//   label:ready                 → auto-ready (limits.yaml auto_ready): record `auto_ready` once, then
//                                 add `factory:ready` to the task issue (re-applied whenever it's
//                                 planned again, so an interrupted label is finished next poll)
//   enqueue_merge               → add the PR to the merge queue (GraphQL enqueuePullRequest); only
//                                 for green auto-tier agent PRs (planner autoMergeBlocker). If
//                                 GitHub refuses, the PR is handed to a person instead
//                                 (needs_human/enqueue_failed). GitHub then merges it once the
//                                 merge-group checks pass; `queued` and `merged` are observed facts.
//   close_task                  → a task whose PR merged: remove `factory:ready` and
//                                 `factory:picked` from its issue, then close it as completed.
//                                 Recorded (`task_done`) first, once; the effect is idempotent and
//                                 re-run while the issue is open, so an interrupted close finishes
//                                 on the next poll.
//   dispatch_workflow:review    → record `review_dispatched` (with the head) first, then dispatch
//                                 review.lock.yml on main with {task, pr, head_sha, contract_sha}.
//                                 If the dispatch fails, the record stands: no second review is
//                                 sent, and with no verdict the PR goes to a person after
//                                 REVIEW_TIMEOUT_MINUTES (fail closed, never a double spend).
//   open_revert                 → auto-strict regression on main: a commit with the merge's parent
//                                 tree on top of the merge commit, on branch `factory/revert-<pr>`,
//                                 and a templated PR to main (each step reuses what exists, so a
//                                 retry never duplicates), then record `auto_revert`. The planner
//                                 enqueues the revert PR once its own ci and gates pass. The
//                                 `needs_human/main_regressed` hand-off is a separate decision.
//   rerun_ci                    → a first post-merge ci failure on main: record, then re-run that
//                                 run once (POST actions/runs/<id>/rerun). Only a second failed
//                                 attempt with the same signature confirms a regression.
//   dispatch_workflow:repair    → record `repair_dispatched` (attempt, run, signature, head) first,
//                                 then dispatch repair.lock.yml on main with the task, issue, PR,
//                                 attempt, contract SHA, failed head, failure signature and failed
//                                 run (no aw_context: the workflow checks out the head). A failed dispatch isn't
//                                 retried (the run is recorded as repaired); the next ci failure or
//                                 the task time limit hands it on (fail closed, never double spend).
//   alert:owner, pause_dispatch, none → no GitHub effect; recorded in the audit log only
// It never merges directly (only the merge queue merges), closes anything but a finished task's
// issue, removes any other label, adds `factory:ready` except by auto-ready to an open task issue,
// or dispatches anything else.
// main.ts then syncs the Project "Factory status" field (project.ts), best-effort.
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
import { REPAIR_WORKFLOW, CLOSE_COMPLETED, REVERT_BRANCH, REVERT_TITLE, COMMENT_MARKER, DONE_REMOVED_LABELS, ENQUEUE_MUTATION, IMPLEMENT_WORKFLOW, MAX_COMMENT_LENGTH, paginate, REVIEW_WORKFLOW } from './github.ts';
import { isRecorded, LABEL_NEEDS_HUMAN, LABEL_PICKED, LABEL_READY } from './planner.ts';
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
  if (typeof d.head_sha === 'string') fields.head_sha = d.head_sha;
  // The reason and effect are part of the dedupe identity: a changed reason for
  // the same subject (missing_task_marker → contract_missing) is a new fact,
  // while an identical retry still dedupes.
  return { type: d.type, source_ids: [...d.source_ids, `reason:${d.reason}`, `effect:${d.effect}`, ...(live ? ['mode:live'] : [])], fields };
}

/** The decision live mode carries out (identity since the repair workflow exists). */
export function liveDecision(d: Decision): Decision {
  return d;
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
  implement_no_pr: 'The implement run for this attempt finished without opening a PR (the agent declined or did nothing; see its comment). To run it again: fix the cause, remove `needs-human`, then close and reopen this issue.',
  implement_failed: 'The implement run for this attempt failed without opening a PR. To run it again: fix the cause, remove `needs-human`, then close and reopen this issue.',
  repair_no_push: 'The repair run finished without pushing a fix (the agent declined or did nothing; see its comment). A person decides.',
  repair_failed: 'The repair run failed without pushing a fix. A person decides.',
  pick_time_unknown: 'The issue is marked picked, but the audit log has no pick time for it.',
  ci_not_repairable: 'CI did not finish normally on this PR (timed out, or never started). That is not repaired automatically: a person decides.',
  task_budget_unknown: "CI failed, but this task's AI spend can't be read, so no repair is paid for.",
  repair_unavailable: 'CI failed. There is no repair workflow yet, so a person decides what to do.',
  full_regression_missing: "This auto-strict change has no successful full regression (the `checks` job's 10,000-phrase held-out step) on its head. A person decides.",
  review_contract_changed: 'This head was reviewed against a different contract version than the current one. A person decides (no second review is sent automatically).',
  main_regressed: '`ci` failed on main at this merge commit (the post-merge check). If this was an auto-strict change merged by the controller, a revert PR is opened and queued automatically; otherwise a person decides.',
  revert_head_changed: "This auto-revert PR's head is no longer the revert commit the controller created (someone pushed to it, or the record is gone). It is not queued automatically. A person decides.",
  revert_checks_failed: 'The checks failed on this auto-revert PR, so it is not queued. A person decides.',
  review_objected: 'The reviewer agent (a second model) objected to this change: see the `factory-review` check. A person decides.',
  review_timeout: 'No verdict from the reviewer agent in time (the review run failed, was flagged or posted nothing). A person decides.',
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

const HEX40 = /^[0-9a-f]{40}$/;

/**
 * The revert of a squash-merged PR on main: a commit whose tree is the merge's parent's tree, with
 * the merge as its parent, on `factory/revert-<pr>`, and a PR from it. Reuses an existing branch
 * (only if it is exactly that revert) and an existing PR, so a retried run never duplicates.
 */
async function openRevert(deps: LiveDeps, pr: number, merge: string, runId: number | null, task: string | null): Promise<{ pr: number; commit: string }> {
  const r = `/repos/${deps.repo}`;
  const mergeCommit = (await deps.client.request('GET', `${r}/git/commits/${merge}`)).data as { parents?: { sha?: unknown }[] } | null;
  const parents = mergeCommit?.parents ?? [];
  const parentSha = parents[0]?.sha;
  if (parents.length !== 1 || typeof parentSha !== 'string' || !HEX40.test(parentSha)) throw new Error(`merge commit ${merge.slice(0, 7)} doesn't have exactly one parent`);
  const parentTree = ((await deps.client.request('GET', `${r}/git/commits/${parentSha}`)).data as { tree?: { sha?: unknown } } | null)?.tree?.sha;
  if (typeof parentTree !== 'string' || !HEX40.test(parentTree)) throw new Error('parent commit has no tree');
  const branch = REVERT_BRANCH(pr);
  const ref = await deps.client.request('GET', `${r}/git/ref/heads/${branch}`, { allowStatuses: [404] });
  let commit: string;
  const existing = (ref.data as { object?: { sha?: unknown } } | null)?.object?.sha;
  if (ref.status === 200 && typeof existing === 'string') {
    const c = (await deps.client.request('GET', `${r}/git/commits/${existing}`)).data as { tree?: { sha?: unknown }; parents?: { sha?: unknown }[] } | null;
    if (c?.tree?.sha !== parentTree || c.parents?.length !== 1 || c.parents[0]?.sha !== merge) throw new Error(`branch ${branch} exists but isn't the revert of ${merge.slice(0, 7)}`);
    commit = existing;
  } else {
    const message = `${REVERT_TITLE(pr)}\n\nci failed on main at ${merge}${runId === null ? '' : ` (run ${runId})`}. Reverts ${merge}.`;
    const created = (await deps.client.request('POST', `${r}/git/commits`, { body: { message, tree: parentTree, parents: [merge] } })).data as { sha?: unknown } | null;
    if (typeof created?.sha !== 'string' || !HEX40.test(created.sha)) throw new Error('revert commit not created');
    commit = created.sha;
    await deps.client.request('POST', `${r}/git/refs`, { body: { ref: `refs/heads/${branch}`, sha: commit } });
  }
  const owner = deps.repo.split('/')[0];
  const open = await paginate(deps.client, `${r}/pulls?head=${owner}:${encodeURIComponent(branch)}&state=all&per_page=100`, (d) => (Array.isArray(d) ? d : []));
  const found = open.map((x) => (x as { number?: unknown }).number).find((n): n is number => typeof n === 'number');
  if (found !== undefined) return { pr: found, commit };
  const body = [
    `${COMMENT_MARKER} · auto-revert`,
    '',
    `Reverts #${pr}${task ? ` (task \`${task}\`)` : ''}: \`ci\` failed on main at its merge commit \`${merge}\`${runId === null ? '' : ` (run ${runId})`}.`,
    '',
    'Opened by the controller and queued once its own checks pass. The task is handed to a person. The controller reverts at most once until a person adds `factory:revert-reviewed` here.',
  ].join('\n');
  const created = (await deps.client.request('POST', `${r}/pulls`, { body: { title: REVERT_TITLE(pr), head: branch, base: 'main', body } })).data as { number?: unknown } | null;
  if (typeof created?.number !== 'number') throw new Error('revert PR not created');
  return { pr: created.number, commit };
}

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
    if (d.effect === 'label:ready') {
      if (d.issue === null) throw new Error('auto_ready decision has no issue');
      if (deps.isNew(ev)) {
        deps.validate(ev);
        await deps.record(ev);
      }
      deps.log(describe(d, true));
      // Only an open factory task issue gets `factory:ready` (read it now: the plan may be stale).
      const issue = (await deps.client.request('GET', `/repos/${deps.repo}/issues/${d.issue}`)).data as { state?: unknown; pull_request?: unknown; labels?: { name?: unknown }[] } | null;
      const names = (issue?.labels ?? []).map((l) => l.name);
      if (issue?.state !== 'open' || issue.pull_request !== undefined || !names.includes('factory:task')) {
        deps.log(`[live] issue #${d.issue} is not an open factory task any more: not marked ready`);
        ran++;
        continue;
      }
      if (!names.includes(LABEL_READY)) await addLabel(deps, d.issue, LABEL_READY);
      ran++;
      continue;
    }
    if (d.effect === 'close_task') {
      if (d.issue === null) throw new Error('task_done decision has no issue');
      // Recorded once (first), then the idempotent effect, every time it's planned (issue still open).
      if (deps.isNew(ev)) {
        deps.validate(ev);
        await deps.record(ev);
      }
      deps.log(describe(d, true));
      for (const label of DONE_REMOVED_LABELS) {
        await deps.client.request('DELETE', `/repos/${deps.repo}/issues/${d.issue}/labels/${encodeURIComponent(label)}`, { allowStatuses: [404] });
      }
      await deps.client.request('PATCH', `/repos/${deps.repo}/issues/${d.issue}`, { body: { ...CLOSE_COMPLETED } });
      ran++;
      continue;
    }
    if (!deps.isNew(ev)) {
      deps.log(`[live] already done: ${d.type}/${d.reason}${d.issue !== null ? ` issue=#${d.issue}` : ''}${d.pr !== null ? ` pr=#${d.pr}` : ''}`);
      continue;
    }
    deps.validate(ev);
    deps.log(describe(d, true));
    if (d.effect === 'dispatch_workflow:implement') {
      if (d.issue === null || d.task === null || d.attempt === null || d.contract_sha === null) throw new Error('dispatch decision is missing task, issue, attempt or contract SHA');
      // A re-dispatch (attempt ≥ 2, after a reopen): record first. Its factory:picked label is already
      // on the issue, so the label can't guard against a second dispatch if the record were lost; a
      // recorded attempt whose dispatch fails stays in flight until the time limit hands it on.
      const redispatch = d.attempt > 1;
      if (redispatch) await deps.record(ev);
      await addLabel(deps, d.issue, LABEL_PICKED);
      await deps.client.request('POST', `/repos/${deps.repo}/actions/workflows/${IMPLEMENT_WORKFLOW}/dispatches`, {
        body: { ref: 'main', inputs: { task: d.task, issue: String(d.issue), attempt: String(d.attempt), contract_sha: d.contract_sha } },
      });
      if (!redispatch) await deps.record(ev);
    } else if (LABEL_OF[d.effect]) {
      if (d.pr === null && d.issue === null) throw new Error(`${d.type}/${d.reason} has no issue or PR to label`);
      // Record first: if a later step fails, the next live run finishes it (pendingHandoffs).
      await deps.record(ev);
      await completeHandoff(deps, { key: dedupeKey(ev.type, ev.source_ids), type: d.type, reason: d.reason, effect: d.effect, issue: d.issue, pr: d.pr });
    } else if (d.effect === 'enqueue_merge') {
      if (d.pr === null) throw new Error('enqueue decision has no PR');
      const prId = d.source_ids[0];
      const head = d.head_sha;
      if (!prId || !/^PR_/.test(prId) || typeof head !== 'string' || !/^[0-9a-f]{40}$/.test(head)) throw new Error('enqueue decision has no PR node id or head');
      // A refusal already handed to a person for this PR and head is final: never ask GitHub again.
      const failed: Decision = { ...d, type: 'needs_human', reason: 'enqueue_failed', effect: 'label:needs-human', source_ids: [...d.source_ids, 'enqueue_failed'] };
      const failedEv = decisionEvent(failed, true);
      if (!deps.isNew(failedEv)) {
        deps.log(`[live] enqueue for pr=#${d.pr} head=${head.slice(0, 7)} was refused before: not retried`);
        continue;
      }
      let refused: string | null = null;
      try {
        const res = await deps.client.request('POST', '/graphql', { body: { query: ENQUEUE_MUTATION, variables: { id: prId, head } } });
        const body = res.data as { errors?: unknown[]; data?: { enqueuePullRequest?: { mergeQueueEntry?: { id?: unknown } } } } | null;
        if (!body || (body.errors && body.errors.length > 0) || typeof body.data?.enqueuePullRequest?.mergeQueueEntry?.id !== 'string') refused = 'GraphQL error';
      } catch (err) {
        if (!(err instanceof Error) || !/HTTP 4\d\d/.test(err.message)) throw err; // transient: fail the run, retry next poll
        refused = err.message;
      }
      if (refused === null) {
        await deps.record(ev); // records the head that was enqueued (history: enqueued)
      } else {
        // A head that moved since planning makes the plan stale: nothing is recorded, and the
        // next poll re-plans for the new head. Otherwise GitHub refused this head: a person decides.
        const now = await deps.client.request('GET', `/repos/${deps.repo}/pulls/${d.pr}`);
        const current = (now.data as { head?: { sha?: unknown } } | null)?.head?.sha;
        if (current !== head) {
          deps.log(`[live] pr=#${d.pr} head moved (${head.slice(0, 7)} → ${String(current).slice(0, 7)}): stale plan, re-planned next poll`);
          continue;
        }
        deps.log(`[live] enqueue refused for pr=#${d.pr} (${refused}): handing it to a person`);
        deps.validate(failedEv);
        await deps.record(failedEv);
        await completeHandoff(deps, { key: dedupeKey(failedEv.type, failedEv.source_ids), type: failed.type, reason: failed.reason, effect: failed.effect, issue: failed.issue, pr: failed.pr });
      }
    } else if (d.effect === 'dispatch_workflow:review') {
      const head = d.head_sha;
      if (d.pr === null || d.task === null || d.contract_sha === null || typeof head !== 'string' || !/^[0-9a-f]{40}$/.test(head)) throw new Error('review decision is missing task, PR, head or contract SHA');
      await deps.record(ev); // first: a failed dispatch is never retried (fail closed via review_timeout)
      await deps.client.request('POST', `/repos/${deps.repo}/actions/workflows/${REVIEW_WORKFLOW}/dispatches`, {
        body: { ref: 'main', inputs: { task: d.task, pr: String(d.pr), head_sha: head, contract_sha: d.contract_sha } },
      });
    } else if (d.effect === 'rerun_ci') {
      if (d.run_id === null) throw new Error('rerun decision has no run');
      await deps.record(ev); // first: one re-run per failed run, never retried
      await deps.client.request('POST', `/repos/${deps.repo}/actions/runs/${d.run_id}/rerun`);
    } else if (d.effect === 'open_revert') {
      const merge = d.merge_commit_sha;
      if (d.pr === null || typeof merge !== 'string' || !/^[0-9a-f]{40}$/.test(merge)) throw new Error('revert decision has no PR or merge commit');
      const revert = await openRevert(deps, d.pr, merge, d.run_id, d.task);
      await deps.record({ ...ev, fields: { ...ev.fields, merge_commit_sha: merge, revert_pr: revert.pr, revert_commit: revert.commit } });
    } else if (d.effect === 'dispatch_workflow:repair') {
      const head = d.head_sha;
      if (d.task === null || d.issue === null || d.pr === null || d.attempt === null || d.contract_sha === null || d.run_id === null || d.failure_signature === null || typeof head !== 'string') {
        throw new Error('repair decision is missing task, issue, PR, attempt, contract, run, signature or head');
      }
      await deps.record(ev); // first: the attempt counts even if the dispatch fails (never retried)
      await deps.client.request('POST', `/repos/${deps.repo}/actions/workflows/${REPAIR_WORKFLOW}/dispatches`, {
        body: {
          ref: 'main',
          inputs: {
            task: d.task,
            issue: String(d.issue),
            pr: String(d.pr),
            attempt: String(d.attempt),
            contract_sha: d.contract_sha,
            head_sha: head,
            failure_signature: d.failure_signature,
            run_id: String(d.run_id),
          },
        },
      });
    } else {
      // alert:owner, pause_dispatch and none have no GitHub effect: the record is the effect.
      await deps.record(ev);
    }
    ran++;
  }
  return ran;
}
