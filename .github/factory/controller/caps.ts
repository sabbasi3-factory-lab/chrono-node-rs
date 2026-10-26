// The spend bound is real only if each compiled workflow enforces exactly the caps budgets.yaml
// names (agent job: per_run.<workflow>; detection job: per_run.threat_detection) and no repository
// variable can change them. Checked at run time against the pinned policy; any mismatch turns the
// bound off (spend.ts: unreadable usage is unknown again) and raises factory:alert.

import type { BudgetsPolicy } from './types.ts';

export const CAPPED_WORKFLOWS = { implement: 'implement', repair: 'repair', review: 'reviewer_agent' } as const;
export type CappedWorkflow = keyof typeof CAPPED_WORKFLOWS;

/** The `"maxAiCredits":N` values inside one top-level job of a compiled lock file. */
function jobCaps(lock: string, job: string): number[] {
  const start = lock.search(new RegExp(`^  ${job}:\\s*$`, 'm'));
  if (start < 0) return [];
  const rest = lock.slice(start + 1);
  const next = rest.search(/^  [a-z_][a-z0-9_-]*:\s*$/m);
  const body = next < 0 ? rest : rest.slice(0, next);
  // The whole JSON value, not its digit prefix (500.5 or 500e2 must not read as 500).
  return [...body.matchAll(/"maxAiCredits":\s*([^,}\s]+)/g)].map((m) => (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(m[1]!) ? Number(m[1]) : NaN));
}

/** Null when every lock enforces exactly the policy's caps; otherwise why not. */
export function lockCapsMismatch(locks: Record<CappedWorkflow, string | null>, perRun: BudgetsPolicy['per_run'], only?: readonly CappedWorkflow[]): string | null {
  for (const [wf, key] of Object.entries(CAPPED_WORKFLOWS) as [CappedWorkflow, keyof typeof perRun][]) {
    if (only && !only.includes(wf)) continue;
    const lock = locks[wf];
    if (lock === null) return `${wf}.lock.yml could not be read`;
    if (/GH_AW_DEFAULT_(DETECTION_)?MAX_AI_CREDITS/.test(lock)) return `${wf}.lock.yml lets a variable set an AI-credits cap`;
    const agent = jobCaps(lock, 'agent');
    const detection = jobCaps(lock, 'detection');
    const want = perRun[key] as number;
    if (agent.length === 0 || agent.some((c) => c !== want)) return `${wf}.lock.yml agent cap ${agent.join(',') || 'missing'} ≠ per_run.${String(key)} ${want}`;
    if (detection.length === 0 || detection.some((c) => c !== perRun.threat_detection)) {
      return `${wf}.lock.yml detection cap ${detection.join(',') || 'missing'} ≠ per_run.threat_detection ${perRun.threat_detection}`;
    }
  }
  return null;
}
