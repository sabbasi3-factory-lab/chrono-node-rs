// The spend bound is real only if each compiled workflow enforces exactly the caps budgets.yaml
// names (agent job: per_run.<workflow>; detection job: per_run.threat_detection; evals job, where
// there is one: per_run.<workflow>, see EVALS_WORKFLOWS) and no repository variable can change them. Checked at run time against the pinned policy; any mismatch turns the
// bound off (spend.ts: unreadable usage is unknown again) and raises factory:alert.

import type { BudgetsPolicy } from './types.ts';

// `improve` is the factory review (Loop 4, DESIGN §15): budgets.yaml per_run.factory_review.
export const CAPPED_WORKFLOWS = { implement: 'implement', repair: 'repair', review: 'reviewer_agent', improve: 'factory_review', triage: 'needs_human_triage' } as const;
/** Workflows the policy may leave out (no cap = off: never dispatched, lock not checked, runs not reserved). */
export const OPTIONAL_WORKFLOWS: readonly CappedWorkflow[] = ['triage'];
export type CappedWorkflow = keyof typeof CAPPED_WORKFLOWS;

// Workflows with gh-aw's `evals` job (a third job that calls the model). gh-aw v1.0.1 has no separate
// evals cap: the job inherits the workflow's max-ai-credits, so it must enforce per_run.<workflow>,
// and spend.ts reserves and bounds it on top of the agent and detection jobs. A lock of any other
// workflow with an evals job (or an evals job without that cap, as in later gh-aw versions that run
// evals outside the firewall) is a mismatch: the spend bound goes off until the controller counts it.
// gh-aw v1.2 does exactly that (one uncapped Decisions API call), so implement and v2-port have no
// evals since #564; implement's evals reservation stays (it only over-reserves) until it's revisited.
export const EVALS_WORKFLOWS: readonly CappedWorkflow[] = ['implement'];

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
    // A v1 config key, or any printf that writes the firewall config.
    const config = raw.includes('\\"maxAiCredits') || (/^\s*printf\b/.test(raw) && raw.includes('awf-config.json'));
    if (tokens.length === 0 && !config) continue;
    const line = raw.trim();
    if (!config && (TEMPLATE_LINES.has(line) || CAP_ASSIGNMENT.test(line))) continue;
    if (configLineOk(line) || line === CHROOT_CONFIG_LINE) continue;
    // gh-aw ≤ v0.92's single-quoted literal config: its values are checked by jobCaps.
    if (line.startsWith("printf '%s\\n' '{") && tokens.length === 0 && !line.includes('\\"')) continue;
    return line.slice(0, 120);
  }
  return null;
}

// Writes back the chroot patch of the config (jq on the file gh-aw just wrote; no cap involved).
const CHROOT_CONFIG_LINE = 'printf \'%s\\n\' "$_GH_AW_CHROOT_JSON" > "${RUNNER_TEMP}/gh-aw/awf-config.json"';

// The whole firewall-config line: printf of one double-quoted string (escaped quotes, backslashes,
// `$`, backticks, or the cap variable; no other expansion) redirected to the config file, nothing else.
const CONFIG_LINE = /^printf '%s\\n' "((?:[^"\\$`]|\\["\\$`]|\$\{GH_AW_MAX_AI_CREDITS\})*)" > "\$\{RUNNER_TEMP\}\/gh-aw\/awf-config\.json"$/;

/** The decoded JSON has one `maxAiCredits` key (JSON keeps the last duplicate), and its value is the cap variable. */
function configLineOk(line: string): boolean {
  const m = CONFIG_LINE.exec(line);
  if (!m || m[1]!.split('${GH_AW_MAX_AI_CREDITS}').length !== 2) return false;
  const json = m[1]!.replace('${GH_AW_MAX_AI_CREDITS}', '"__cap__"').replace(/\\(["\\$`])/g, '$1');
  // No JSON escapes at all, so no key can be spelled another way (`maxAi\u0043redits`).
  if (json.includes('\\') || json.split('"maxAiCredits"').length !== 2) return false;
  try {
    return (JSON.parse(json) as { apiProxy?: { maxAiCredits?: unknown } }).apiProxy?.maxAiCredits === '__cap__';
  } catch {
    return false;
  }
}

/** Whether the compiled lock has this top-level job. */
function hasJob(lock: string, job: string): boolean {
  return new RegExp(`^  ${job}:\\s*$`, 'm').test(lock);
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
    if (OPTIONAL_WORKFLOWS.includes(wf) && (perRun[key] === undefined || perRun[key] === null)) continue;
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
    // A lock without the evals job (implement before #164) spends less than reserved: it still verifies.
    if (EVALS_WORKFLOWS.includes(wf) && hasJob(lock, 'evals')) {
      const evals = jobCaps(lock, 'evals');
      if (evals.length === 0 || evals.some((c) => c !== want)) return `${wf}.lock.yml evals cap ${evals.join(',') || 'missing'} ≠ per_run.${String(key)} ${want}`;
    } else if (!EVALS_WORKFLOWS.includes(wf) && hasJob(lock, 'evals')) {
      return `${wf}.lock.yml has an evals job the controller doesn't reserve (caps.ts EVALS_WORKFLOWS)`;
    }
  }
  return null;
}
