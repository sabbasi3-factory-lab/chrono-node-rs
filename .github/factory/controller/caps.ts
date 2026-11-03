// The spend bound is real only if each compiled workflow enforces exactly the caps budgets.yaml
// names (agent job: per_run.<workflow>; detection job: per_run.threat_detection) and no repository
// variable can change them. Checked at run time against the pinned policy; any mismatch turns the
// bound off (spend.ts: unreadable usage is unknown again) and raises factory:alert.

import type { BudgetsPolicy } from './types.ts';

export const CAPPED_WORKFLOWS = { implement: 'implement', repair: 'repair', review: 'reviewer_agent' } as const;
export type CappedWorkflow = keyof typeof CAPPED_WORKFLOWS;

// gh-aw v1 sets the cap in bash (`GH_AW_MAX_AI_CREDITS="N"`, env `GH_AW_MAX_AI_CREDITS: "N"`) and the
// firewall config reads it (`\"maxAiCredits\":${GH_AW_MAX_AI_CREDITS}`); its opt-in admission can
// replace it at run time. Every line that names the cap or admission must be one of these template
// lines, so no other assignment form (unquoted, `+=`, `export`, a variable, GITHUB_ENV, an admission
// env) can slip past. gh-aw ≤ v0.92 inlined `"maxAiCredits":N` instead and only has the env line.
const CAP_ASSIGNMENT = /^GH_AW_MAX_AI_CREDITS(?:="([^"]*)"|: "([^"]*)")$/;
const ADMISSION_OVERRIDE = 'GH_AW_MAX_AI_CREDITS="$GH_AW_ADMISSION_MAX_AI_CREDITS"';
const CONFIG_REF = '\\"maxAiCredits\\":${GH_AW_MAX_AI_CREDITS},';
const TEMPLATE_LINES = new Set([
  'if [[ ! "$GH_AW_MAX_AI_CREDITS" =~ ^[0-9]+$ ]]; then',
  ADMISSION_OVERRIDE,
  'if [[ "${GH_AW_ADMISSION_RESULT:-}" == "admitted" && -z "${GH_AW_ADMISSION_MAX_AI_CREDITS:-}" ]]; then',
  'if [[ "${GH_AW_ADMISSION_RESULT:-}" == "admitted" && -n "${GH_AW_ADMISSION_MAX_AI_CREDITS:-}" ]]; then',
  'if [[ ! "$GH_AW_ADMISSION_MAX_AI_CREDITS" =~ ^[1-9][0-9]{0,9}$ ]] || (( GH_AW_ADMISSION_MAX_AI_CREDITS > 2147483647 )); then',
  'unset GH_AW_ADMISSION_RESULT GH_AW_ADMISSION_MAX_AI_CREDITS',
  "if: ${{ env.GH_AW_ADMISSION_RESULT != 'admitted' && env.GH_AW_MAX_DAILY_AI_CREDITS != '' }}",
  "if: always() && env.GH_AW_ADMISSION_RESULT != 'admitted' && env.GH_AW_MAX_DAILY_AI_CREDITS != ''",
]);
const CAP_TOKEN = /\bGH_AW_MAX_AI_CREDITS\b|GH_AW_ADMISSION_/g;

/** The first line naming the cap, admission or a v1 `maxAiCredits` config that isn't gh-aw's template, or null. */
export function unexpectedCapLine(lock: string): string | null {
  for (const raw of lock.split('\n')) {
    const tokens = raw.match(CAP_TOKEN) ?? [];
    const config = raw.includes('\\"maxAiCredits');
    if (tokens.length === 0 && !config) continue;
    const line = raw.trim();
    if (!config && (TEMPLATE_LINES.has(line) || CAP_ASSIGNMENT.test(line))) continue;
    // The firewall config line: one maxAiCredits key (JSON keeps the last duplicate), whose whole
    // value is the variable, and no other mention of it.
    if (line.startsWith("printf '%s\\n' \"{") && tokens.length === 1 && line.split(CONFIG_REF).length === 2 && line.split('maxAiCredits').length === 2) continue;
    return line.slice(0, 120);
  }
  return null;
}

/** The AI-credits caps inside one top-level job of a compiled lock file (either format). */
function jobCaps(lock: string, job: string): number[] {
  const start = lock.search(new RegExp(`^  ${job}:\\s*$`, 'm'));
  if (start < 0) return [];
  const rest = lock.slice(start + 1);
  const next = rest.search(/^  [a-z_][a-z0-9_-]*:\s*$/m);
  const body = next < 0 ? rest : rest.slice(0, next);
  // The whole value, not its digit prefix (500.5 or 500e2 must not read as 500).
  const num = (v: string): number => (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(v) ? Number(v) : NaN);
  const legacy = [...body.matchAll(/(?<!\\)"maxAiCredits":\s*([^,}\s]+)/g)].map((m) => num(m[1]!));
  const v1: number[] = [];
  for (const line of body.split('\n').map((l) => l.trim())) {
    const m = CAP_ASSIGNMENT.exec(line);
    if (m && line !== ADMISSION_OVERRIDE) v1.push(num((m[1] ?? m[2])!));
  }
  // v1 assignments cap nothing unless this job's firewall config reads them.
  if (v1.length > 0 && !body.includes(CONFIG_REF)) v1.push(NaN);
  return [...legacy, ...v1];
}

/** Null when every lock enforces exactly the policy's caps; otherwise why not. */
export function lockCapsMismatch(locks: Record<CappedWorkflow, string | null>, perRun: BudgetsPolicy['per_run'], only?: readonly CappedWorkflow[]): string | null {
  for (const [wf, key] of Object.entries(CAPPED_WORKFLOWS) as [CappedWorkflow, keyof typeof perRun][]) {
    if (only && !only.includes(wf)) continue;
    const lock = locks[wf];
    if (lock === null) return `${wf}.lock.yml could not be read`;
    if (/GH_AW_DEFAULT_(DETECTION_)?MAX_AI_CREDITS/.test(lock)) return `${wf}.lock.yml lets a variable set an AI-credits cap`;
    const odd = unexpectedCapLine(lock);
    if (odd !== null) return `${wf}.lock.yml sets an AI-credits cap outside gh-aw's template: ${odd}`;
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
