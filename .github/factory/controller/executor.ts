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
//   dispatch_workflow:repair    → no repair workflow exists yet: escalated instead to
//                                 needs_human/repair_unavailable (label + comment)
//   alert:owner, pause_dispatch, none → no GitHub effect; recorded in the audit log only
// It never merges, closes, removes a label, adds `factory:ready`, or dispatches anything else.
//
// Each decision's effect runs only if its audit event is new (the same dedupe key as the dry-run
// record), is validated before any effect, and is recorded (dry_run: false) right after it. A
// dispatch labels the issue `factory:picked` BEFORE dispatching: if anything fails after that,
// the planner sees a picked issue without a pick time and hands it to a human
// (needs_human/pick_time_unknown) instead of dispatching it twice.

import { COMMENT_MARKER, IMPLEMENT_WORKFLOW, MAX_COMMENT_LENGTH } from './github.ts';
import { isRecorded, LABEL_NEEDS_HUMAN, LABEL_PICKED } from './planner.ts';
import type { Decision, GitHubClient, JsonObject, PendingEvent, PlannerEnv, ReasonCode } from './types.ts';

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

/** The audit event recorded for a non-wait decision (dedupe on source ids + reason + effect). */
export function decisionEvent(d: Decision): PendingEvent {
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
  return { type: d.type, source_ids: [...d.source_ids, `reason:${d.reason}`, `effect:${d.effect}`], fields };
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
  invalid_contract: "The task's contract on main can't be used.",
  missing_contract_sha: 'The PR has no `Contract-SHA:` trailer.',
  missing_task_marker: 'The issue has no valid factory task marker.',
  duplicate_task: 'Another open issue already has this task.',
  contract_missing: 'There is no contract for this task on main.',
  contract_changed: "The contract changed after this PR's `Contract-SHA:`.",
};

export function commentBody(d: Decision, label: string, runUrl: string | null): string {
  const text = REASON_TEXT[d.reason] ?? 'See the audit log for details.';
  const body = [
    `${COMMENT_MARKER} · \`${d.type}\` (\`${d.reason}\`)`,
    '',
    text,
    '',
    `Labelled \`${label}\`. The controller doesn't remove labels; a person does.${runUrl ? ` Run: ${runUrl}` : ''}`,
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
}

async function addLabel(deps: LiveDeps, number: number, label: string): Promise<void> {
  await deps.client.request('POST', `/repos/${deps.repo}/issues/${number}/labels`, { body: { labels: [label] } });
}

/** Live: take each decision's effect once, then record it. Returns how many decisions ran. */
export async function executeLive(decisions: Decision[], deps: LiveDeps): Promise<number> {
  let ran = 0;
  for (const planned of decisions) {
    if (!isRecorded(planned)) {
      deps.log(describe(planned, true));
      continue;
    }
    const d = liveDecision(planned);
    const ev = decisionEvent(d);
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
    } else if (LABEL_OF[d.effect]) {
      const label = LABEL_OF[d.effect]!;
      const targets = [d.pr, d.issue].filter((n): n is number => n !== null);
      if (targets.length === 0) throw new Error(`${d.type}/${d.reason} has no issue or PR to label`);
      for (const n of targets) await addLabel(deps, n, label);
      await deps.client.request('POST', `/repos/${deps.repo}/issues/${targets[0]}/comments`, { body: { body: commentBody(d, label, deps.runUrl) } });
    } else if (d.effect === 'dispatch_workflow:repair') {
      throw new Error('repair dispatch is not available');
    }
    // alert:owner, pause_dispatch and none have no GitHub effect: the record is the effect.
    await deps.record(ev);
    ran++;
  }
  return ran;
}
