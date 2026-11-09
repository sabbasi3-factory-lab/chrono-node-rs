// Loads factory policies at the pinned factory version. Any failure (network,
// HTTP status, YAML, missing or wrongly-typed field) throws: fail closed.

import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import type { BudgetsPolicy, CadencePolicy, LimitsPolicy, OnboardingPolicy, Overshoot, Policies, TiersPolicy } from './types.ts';

export const FACTORY_REPO = 'sabbasi3-factory-lab/factory';
export const POLICY_NAMES = ['limits', 'budgets', 'tiers', 'cadence', 'onboarding'] as const;
export type PolicyName = (typeof POLICY_NAMES)[number];
export type PolicyTexts = Record<PolicyName, string>;

const FULL_SHA = /^[0-9a-f]{40}$/;

/** Reads `.github/factory/factory-version` (one line, a full commit SHA). */
export async function readFactoryVersion(path: string | URL): Promise<string> {
  return parseFactoryVersion(await readFile(path, 'utf8'));
}

export function parseFactoryVersion(text: string): string {
  const sha = text.trim();
  if (!FULL_SHA.test(sha) || text.replace(/\n$/, '') !== sha) {
    throw new Error('factory-version must be exactly one line containing a full 40-hex commit SHA');
  }
  return sha;
}

export function policyUrl(sha: string, name: PolicyName): string {
  if (!FULL_SHA.test(sha)) throw new Error('factory version must be a full commit SHA');
  return `https://raw.githubusercontent.com/${FACTORY_REPO}/${sha}/policies/${name}.yaml`;
}

export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export async function fetchPolicyTexts(sha: string, fetchFn: FetchLike = fetch): Promise<PolicyTexts> {
  const out: Partial<PolicyTexts> = {};
  for (const name of POLICY_NAMES) {
    const url = policyUrl(sha, name);
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(`policy ${name}: HTTP ${res.status}`);
    out[name] = await res.text();
  }
  return out as PolicyTexts;
}

export async function loadPolicies(sha: string, fetchFn: FetchLike = fetch): Promise<Policies> {
  return parsePolicies(await fetchPolicyTexts(sha, fetchFn));
}

export async function loadPoliciesFromDir(dir: URL): Promise<Policies> {
  const out: Partial<PolicyTexts> = {};
  for (const name of POLICY_NAMES) out[name] = await readFile(new URL(`${name}.yaml`, dir), 'utf8');
  return parsePolicies(out as PolicyTexts);
}

function get(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function num(root: unknown, file: string, path: string, min = 0): number {
  const v = get(root, path);
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min) {
    throw new Error(`policy ${file}: ${path} must be a number >= ${min}`);
  }
  return v;
}

function bool(root: unknown, file: string, path: string): boolean {
  const v = get(root, path);
  if (typeof v !== 'boolean') throw new Error(`policy ${file}: ${path} must be a boolean`);
  return v;
}

function strList(root: unknown, file: string, path: string): string[] {
  const v = get(root, path);
  if (!Array.isArray(v) || !v.every((s) => typeof s === 'string')) {
    throw new Error(`policy ${file}: ${path} must be a list of strings`);
  }
  return v as string[];
}

function version1(root: unknown, file: string): void {
  if (get(root, 'version') !== 1) throw new Error(`policy ${file}: unsupported version`);
}

/**
 * per_run.overshoot_margin with its two assumptions. All three missing → null (no spend bound:
 * unreadable usage stays unknown). Partly present, or a margin below max response × max
 * concurrency → the policy is invalid (fail closed).
 */
function overshootOf(b: unknown): Overshoot | null {
  const keys = ['overshoot_margin', 'overshoot_assumed_max_response_aic', 'overshoot_assumed_max_concurrency'] as const;
  const present = keys.filter((k) => get(b, `per_run.${k}`) !== undefined);
  if (present.length === 0) return null;
  if (present.length !== keys.length) throw new Error('policy budgets: per_run.overshoot_margin needs both assumptions (max response, max concurrency)');
  const o: Overshoot = {
    margin: num(b, 'budgets', 'per_run.overshoot_margin', 1),
    max_response_aic: num(b, 'budgets', 'per_run.overshoot_assumed_max_response_aic', 1),
    max_concurrency: num(b, 'budgets', 'per_run.overshoot_assumed_max_concurrency', 1),
  };
  if (!Number.isInteger(o.max_concurrency)) throw new Error('policy budgets: per_run.overshoot_assumed_max_concurrency must be an integer');
  if (o.margin < o.max_response_aic * o.max_concurrency) throw new Error('policy budgets: per_run.overshoot_margin is below max response × max concurrency');
  return o;
}

export function parsePolicies(texts: PolicyTexts): Policies {
  const doc = (name: PolicyName): unknown => {
    const v: unknown = parse(texts[name]);
    if (v === null || typeof v !== 'object') throw new Error(`policy ${name}: not a mapping`);
    version1(v, name);
    return v;
  };
  const l = doc('limits');
  const limits: LimitsPolicy = {
    version: 1,
    wip: {
      start: num(l, 'limits', 'wip.start', 1),
      max: num(l, 'limits', 'wip.max', 1),
      adaptive: {
        org_concurrent_job_limit: num(l, 'limits', 'wip.adaptive.org_concurrent_job_limit', 1),
        pause_dispatch_when_busy_jobs_over: num(l, 'limits', 'wip.adaptive.pause_dispatch_when_busy_jobs_over'),
      },
      core_area: num(l, 'limits', 'wip.core_area'),
    },
    ci: {
      max_jobs_per_pr: num(l, 'limits', 'ci.max_jobs_per_pr', 1),
      // Optional switch (default off): only an explicit `true` makes the merge stage wait for code scanning.
      wait_for_code_scanning: get(l, 'ci.wait_for_code_scanning') === true,
    },
    task: {
      max_attempts: num(l, 'limits', 'task.max_attempts', 1),
      max_repairs: num(l, 'limits', 'task.max_repairs'),
      stop_on_repeated_signature: bool(l, 'limits', 'task.stop_on_repeated_signature'),
      max_wall_clock_hours: num(l, 'limits', 'task.max_wall_clock_hours', 1),
      flaky_requeue: num(l, 'limits', 'task.flaky_requeue'),
    },
    human_queue: { max_items: num(l, 'limits', 'human_queue.max_items') },
    fail_closed: bool(l, 'limits', 'fail_closed'),
    // Optional switch (default off): only an explicit `true` turns auto-ready on.
    auto_ready: get(l, 'auto_ready') === true,
  };
  if (limits.wip.start > limits.wip.max) throw new Error('policy limits: wip.start > wip.max');
  if (!limits.fail_closed) throw new Error('policy limits: controller v1 requires fail_closed: true');

  const b = doc('budgets');
  const budgets: BudgetsPolicy = {
    version: 1,
    per_task: { max_aic: num(b, 'budgets', 'per_task.max_aic') },
    per_run: {
      implement: num(b, 'budgets', 'per_run.implement', 1),
      reviewer_agent: num(b, 'budgets', 'per_run.reviewer_agent', 1),
      factory_review: num(b, 'budgets', 'per_run.factory_review', 1),
      repair: num(b, 'budgets', 'per_run.repair', 1),
      threat_detection: num(b, 'budgets', 'per_run.threat_detection', 1),
      // Optional: absent = the needs-human pre-triage agent is off. Present must be a positive cap.
      needs_human_triage: get(b, 'per_run.needs_human_triage') == null ? null : num(b, 'budgets', 'per_run.needs_human_triage', 1),
      overshoot: overshootOf(b),
    },
    factory_per_day: {
      max_aic: num(b, 'budgets', 'factory_per_day.max_aic', 1),
      alert_at_pct: num(b, 'budgets', 'factory_per_day.alert_at_pct'),
      pause_at_pct: num(b, 'budgets', 'factory_per_day.pause_at_pct'),
    },
  };

  const t = doc('tiers');
  const startAs = get(t, 'tiers.auto-strict.start_as');
  if (startAs !== undefined && startAs !== 'auto' && startAs !== 'auto-strict' && startAs !== 'human') {
    throw new Error('policy tiers: tiers.auto-strict.start_as must be a tier');
  }
  // Gate names only; a malformed list doesn't stop the controller, it only holds the promotion.
  const rawGates = get(t, 'tiers.auto-strict.strict_gates');
  let strictGates: string[] | null = null;
  if (Array.isArray(rawGates)) {
    const names = rawGates.map((g: unknown) => {
      if (typeof g === 'string') return g;
      if (g !== null && typeof g === 'object' && !Array.isArray(g) && Object.keys(g).length === 1) return Object.keys(g)[0]!;
      return null;
    });
    strictGates = names.every((n): n is string => typeof n === 'string' && n.length > 0) ? names : null;
  }
  const tiers: TiersPolicy = {
    version: 1,
    tiers: {
      auto: { paths: strList(t, 'tiers', 'tiers.auto.paths') },
      'auto-strict': {
        paths: strList(t, 'tiers', 'tiers.auto-strict.paths'),
        ...(startAs !== undefined ? { start_as: startAs } : {}),
        strict_gates: strictGates,
      },
      human: { paths: strList(t, 'tiers', 'tiers.human.paths') },
    },
    protected_from_agents: strList(t, 'tiers', 'protected_from_agents'),
    intake_fixes: intakeFixesOf(get(t, 'intake_fixes')),
    onboarding: autoMergePolicyOf(get(t, 'onboarding'), 'onboarding', 5),
  };

  const c = doc('cadence');
  if (get(c, 'heartbeat') !== 'hourly') throw new Error('policy cadence: controller v1 supports heartbeat: hourly only');
  const cadence = c as CadencePolicy;

  // onboarding.yaml: the controller reads only `external_locales` (generated on main, never
  // factory-run: no dispatch, no auto-ready). Required like every policy (a missing file fails the run).
  const o = doc('onboarding');
  const ext = get(o, 'external_locales');
  if (ext !== undefined && (!Array.isArray(ext) || !ext.every((x) => typeof x === 'string' && /^[a-z]{2}(?:-[a-z]{4})?$/.test(x)))) {
    throw new Error('policy onboarding: external_locales must be a list of locale codes');
  }
  const onboarding: OnboardingPolicy = { external_locales: (ext as string[] | undefined) ?? [] };

  return { limits, budgets, tiers, cadence, onboarding };
}

/** tiers.yaml `<name>: {auto_merge, max_per_day 0-max}`. Absent → null; malformed → an error (fail closed). */
function autoMergePolicyOf(v: unknown, name: string, max: number): { auto_merge: boolean; max_per_day: number } | null {
  if (v === undefined) return null;
  const r = v as Record<string, unknown> | null;
  if (r === null || typeof r !== 'object' || Array.isArray(r) || typeof r.auto_merge !== 'boolean') {
    throw new Error(`policy tiers: ${name} must be {auto_merge: boolean, max_per_day: integer 0-${max}}`);
  }
  const n = r.max_per_day;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > max) throw new Error(`policy tiers: ${name}.max_per_day must be an integer 0-${max}`);
  return { auto_merge: r.auto_merge, max_per_day: n };
}

/**
 * tiers.yaml `intake_fixes: {auto_merge, max_per_day}`. Absent → null (the owner merges intake fix
 * PRs). Present but malformed → an error (fail closed, like any other policy field).
 */
function intakeFixesOf(v: unknown): TiersPolicy['intake_fixes'] {
  if (v === undefined) return null;
  const r = v as Record<string, unknown> | null;
  if (r === null || typeof r !== 'object' || Array.isArray(r) || typeof r.auto_merge !== 'boolean') {
    throw new Error('policy tiers: intake_fixes must be {auto_merge: boolean, max_per_day: integer 0-20}');
  }
  const max = r.max_per_day;
  if (typeof max !== 'number' || !Number.isInteger(max) || max < 0 || max > 20) {
    throw new Error('policy tiers: intake_fixes.max_per_day must be an integer 0-20');
  }
  return { auto_merge: r.auto_merge, max_per_day: max };
}
