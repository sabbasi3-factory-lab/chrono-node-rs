// Diagnosis follow-up (live only, fail-soft). When the controller handed a task to a person
// because its implement run failed or opened no PR (needs_human: implement_failed /
// implement_no_pr), and the newest outcomes snapshot holds a gh-aw `audit` diagnosis for exactly
// that run, it posts ONE templated comment on the task issue: up to three fixed sentences from
// the code table below (unknown codes are shown as `code`), a link to the run, and the hint to
// run `gh aw audit <run-id>` locally. No text from gh-aw, issues or agents reaches the comment:
// only validated snake_case codes and numbers. Deduped per run by a `diagnosis_posted` audit event,
// with a hidden marker in the comment so an interrupted post is never repeated.

import { dedupeKey, type AuditLog } from './audit.ts';
import { COMMENT_MARKER, MAX_COMMENT_LENGTH, paginate } from './github.ts';
import type { OutcomeRun } from './outcomes.ts';
import type { AuditEvent, GitHubClient, IssueSnap } from './types.ts';

export const DIAGNOSIS_EVENT = 'diagnosis_posted';
export const DIAGNOSIS_REASONS: readonly string[] = ['implement_failed', 'implement_no_pr'];
/** Lines of findings in a comment. */
export const DIAGNOSIS_LINES = 3;
/** Comments posted per poll at most. */
export const MAX_DIAGNOSES_PER_RUN = 5;

/** gh-aw v0.92.0 audit finding codes (docs/reference/audit.md) → one plain sentence each. */
export const DIAGNOSIS_TEXT: Readonly<Record<string, string>> = {
  workflow_failed: 'The agent run failed before finishing.',
  workflow_timeout: 'The agent run timed out.',
  workflow_succeeded: 'The workflow itself finished without an error.',
  high_token_usage: 'The run used an unusually large number of tokens.',
  many_iterations: 'The agent took many turns.',
  multiple_errors: 'The run logged more than five errors.',
  mcp_server_failures: 'One or more MCP servers failed.',
  tools_not_available: 'Tools the agent asked for were not available.',
  blocked_network_requests: 'The firewall blocked network requests.',
  threat_detection_job_failed: 'The threat-detection job failed.',
  threat_detected: 'Threat detection flagged the output.',
  agentic_resource_heavy_for_domain: 'Resource use was high for this kind of task.',
  agentic_overkill_for_agentic: 'The task may not need an agentic run.',
  agentic_poor_agentic_control: 'The agent showed weak control signals.',
  agentic_partially_reducible: 'Part of the task could be deterministic steps.',
  agentic_model_downgrade_available: 'A smaller model may be enough.',
  agentic_delegated_context_present: 'Delegated workflow context was preserved.',
};

export const diagnosisMarker = (runId: number): string => `<!-- factory-diagnosis: ${runId} -->`;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;

export function diagnosisComment(repo: string, runId: number, reason: string, diagnosis: { codes: readonly string[]; severity: string | null }): string {
  if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error('bad run id');
  const lines = diagnosis.codes.filter((c) => CODE.test(c)).slice(0, DIAGNOSIS_LINES).map((c) => `- ${DIAGNOSIS_TEXT[c] ?? `\`${c}\``}`);
  const body = [
    `${COMMENT_MARKER} · diagnosis of implement run ${runId} (\`${reason}\`)`,
    '',
    `gh-aw audit${diagnosis.severity ? ` (severity: ${diagnosis.severity})` : ''}:`,
    ...lines,
    '',
    `Run: https://github.com/${repo}/actions/runs/${runId}. For details, run \`gh aw audit ${runId}\` locally.`,
    '',
    diagnosisMarker(runId),
  ].join('\n');
  if (body.length > MAX_COMMENT_LENGTH) throw new Error('comment too long');
  return body;
}

export interface PendingDiagnosis {
  issue: number;
  run_id: number;
  reason: string;
  codes: string[];
  severity: string | null;
}

const posInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

/**
 * Diagnoses due: a live needs_human (implement_failed / implement_no_pr) record with its run id, an
 * open task issue that is still with a person (`needs-human`, or the hand-off was recorded this
 * poll), a diagnosis with at least one code for that run in the snapshot, and none posted yet.
 */
export function pendingDiagnoses(events: readonly AuditEvent[], appendedNow: readonly AuditEvent[], runs: ReadonlyMap<number, OutcomeRun> | null, issues: readonly IssueSnap[], posted: (key: string) => boolean): PendingDiagnosis[] {
  if (!runs) return [];
  const out: PendingDiagnosis[] = [];
  const seen = new Set<number>();
  const now = new Set(appendedNow);
  for (const e of [...events].reverse()) {
    const p = e.payload;
    if (e.type !== 'needs_human' || p.dry_run !== false || typeof p.reason !== 'string' || !DIAGNOSIS_REASONS.includes(p.reason)) continue;
    if (!posInt(p.run_id) || !posInt(p.issue) || seen.has(p.run_id)) continue;
    seen.add(p.run_id);
    const issue = issues.find((i) => i.number === p.issue);
    if (!issue || !(issue.labels.includes('needs-human') || now.has(e))) continue;
    const d = runs.get(p.run_id)?.diagnosis;
    if (!d || d.codes.length === 0) continue;
    if (posted(dedupeKey(DIAGNOSIS_EVENT, [`diagnosis:${p.run_id}`]))) continue;
    out.push({ issue: p.issue, run_id: p.run_id, reason: p.reason, codes: [...d.codes], severity: d.severity });
  }
  return out.slice(0, MAX_DIAGNOSES_PER_RUN);
}

/**
 * Live: the comment (unless one with its marker exists), then `diagnosis_posted`. Dry-run: a log
 * line only, nothing recorded. Each failure is logged and skipped (fail-soft). Returns how many posted.
 */
export async function postDiagnoses(client: GitHubClient, repo: string, audit: AuditLog, pending: readonly PendingDiagnosis[], live: boolean, now: Date, log: (line: string) => void): Promise<number> {
  let done = 0;
  for (const d of pending) {
    if (!live) {
      log(`[dry-run] would post the gh-aw diagnosis of run ${d.run_id} on #${d.issue} (${d.codes.join(',')})`);
      continue;
    }
    try {
      const marker = diagnosisMarker(d.run_id);
      const comments = await paginate(client, `/repos/${repo}/issues/${d.issue}/comments?per_page=100`, (x) => (Array.isArray(x) ? x : []));
      const already = comments.some((c) => typeof (c as { body?: unknown }).body === 'string' && (c as { body: string }).body.includes(marker));
      if (!already) await client.request('POST', `/repos/${repo}/issues/${d.issue}/comments`, { body: { body: diagnosisComment(repo, d.run_id, d.reason, d) } });
      await audit.append({ type: DIAGNOSIS_EVENT, source_ids: [`diagnosis:${d.run_id}`], fields: { run_id: d.run_id, issue: d.issue, reason: d.reason, codes: d.codes, severity: d.severity }, dry_run: false }, now);
      done++;
      log(`[live] posted the gh-aw diagnosis of run ${d.run_id} on #${d.issue}`);
    } catch (err) {
      log(`diagnosis of run ${d.run_id} not posted (${(err as Error).message}); retried next poll`);
    }
  }
  return done;
}
