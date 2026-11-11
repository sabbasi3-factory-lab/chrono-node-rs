import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { CAPPED_WORKFLOWS, lockCapsMismatch, type CappedWorkflow } from '../caps.ts';
import { testPolicies } from './helpers.ts';

// The spend bound counts a completed run with unreadable usage at its caps plus the overshoot
// margin. That's an upper bound only if each compiled workflow enforces exactly the policy's caps,
// with no variable able to raise them. main.ts runs lockCapsMismatch against the PINNED policy on
// every poll (a mismatch turns the bound off and raises factory:alert); this pins it on the repo.
const read = async (): Promise<Record<CappedWorkflow, string>> => {
  const out = {} as Record<CappedWorkflow, string>;
  for (const wf of Object.keys(CAPPED_WORKFLOWS) as CappedWorkflow[]) out[wf] = await readFile(new URL(`../../../workflows/${wf}.lock.yml`, import.meta.url), 'utf8');
  return out;
};

describe('the spend bound is real: compiled caps equal the policy', () => {
  it('the committed locks enforce exactly budgets.yaml per_run (agent, detection and evals jobs, no variables)', async () => {
    assert.equal(lockCapsMismatch(await read(), (await testPolicies()).budgets.per_run), null);
  });

  it('the needs-human triage lock: not checked while the policy leaves it off; with a cap, it must enforce exactly that', async () => {
    const per = (await testPolicies()).budgets.per_run;
    const locks = await read();
    assert.equal(per.needs_human_triage ?? null, null);
    assert.equal(lockCapsMismatch({ ...locks, triage: null }, per), null, 'off: a missing lock is fine');
    assert.equal(lockCapsMismatch(locks, { ...per, needs_human_triage: 150 }), null);
    assert.match(String(lockCapsMismatch(locks, { ...per, needs_human_triage: 200 })), /triage\.lock\.yml agent cap 150(,150)* ≠ per_run\.needs_human_triage 200/);
    assert.match(String(lockCapsMismatch({ ...locks, triage: null }, { ...per, needs_human_triage: 150 })), /triage\.lock\.yml could not be read/);
  });

  it('any drift is a mismatch: agent cap, detection cap, a variable override, a missing lock, a policy change', async () => {
    const per = (await testPolicies()).budgets.per_run;
    const locks = await read();
    const agentStart = locks.implement.search(/^ {2}agent:\s*$/m);
    const detStart = locks.implement.search(/^ {2}detection:\s*$/m);
    assert.ok(agentStart > 0 && detStart > agentStart);
    const agentCap = (l: string, v: string) => l.slice(0, detStart).replaceAll('GH_AW_MAX_AI_CREDITS="500"', `GH_AW_MAX_AI_CREDITS="${v}"`) + l.slice(detStart);
    const repairDet = locks.repair.search(/^ {2}detection:\s*$/m);
    // One extra shell line right after implement's agent-job cap assignment.
    const after = (l: typeof locks, line: string) => ({ ...l, implement: l.implement.replace('GH_AW_MAX_AI_CREDITS="500"\n', `GH_AW_MAX_AI_CREDITS="500"\n          ${line}\n`) });
    const cases: [string, Record<CappedWorkflow, string | null>, typeof per, RegExp][] = [
      ['agent cap 600 in implement', { ...locks, implement: agentCap(locks.implement, '600') }, per, /implement\.lock\.yml agent cap 600/],
      ['detection cap 450 in repair', { ...locks, repair: locks.repair.slice(0, repairDet) + locks.repair.slice(repairDet).replaceAll('GH_AW_MAX_AI_CREDITS="400"', 'GH_AW_MAX_AI_CREDITS="450"') }, per, /repair\.lock\.yml detection cap 450/],
      ['a variable can set a cap', { ...locks, review: `${locks.review}\n# \${{ vars.GH_AW_DEFAULT_DETECTION_MAX_AI_CREDITS }}\n` }, per, /lets a variable set/],
      ['admission can set a cap', { ...locks, review: locks.review.replace(/^ {2}agent:\s*$/m, '  agent:\n    env:\n      GH_AW_ADMISSION_RESULT: admitted') }, per, /outside gh-aw's template/],
      ['a step exports an admission result', { ...locks, repair: `${locks.repair}\n          echo "GH_AW_ADMISSION_RESULT=admitted" >> "$GITHUB_ENV"\n` }, per, /outside gh-aw's template/],
      ['the firewall config reads another variable', { ...locks, implement: locks.implement.slice(0, detStart).replace('maxAiCredits\\":${GH_AW_MAX_AI_CREDITS}', 'maxAiCredits\\":${OTHER}') + locks.implement.slice(detStart) }, per, /implement\.lock\.yml sets an AI-credits cap outside/],
      ['the config appends to the variable (${GH_AW_MAX_AI_CREDITS}0 = 5000)', { ...locks, implement: locks.implement.slice(0, detStart).replace('maxAiCredits\\":${GH_AW_MAX_AI_CREDITS}', 'maxAiCredits\\":${GH_AW_MAX_AI_CREDITS}0') + locks.implement.slice(detStart) }, per, /implement\.lock\.yml sets an AI-credits cap outside/],
      ['the config no longer reads the cap', { ...locks, implement: locks.implement.slice(0, detStart).replace('\\"maxAiCredits\\":${GH_AW_MAX_AI_CREDITS},', '') + locks.implement.slice(detStart) }, per, /implement\.lock\.yml sets an AI-credits cap outside/],
      // Independent review: other ways to change the cap, or turn admission on, after the template line.
      ['an unquoted reassignment', after(locks, 'GH_AW_MAX_AI_CREDITS=5000'), per, /outside gh-aw's template: GH_AW_MAX_AI_CREDITS=5000/],
      ['an appending reassignment', after(locks, 'GH_AW_MAX_AI_CREDITS+="0"'), per, /outside gh-aw's template/],
      ['a variable reassignment', after(locks, 'GH_AW_MAX_AI_CREDITS=${{ vars.CAP }}'), per, /outside gh-aw's template/],
      ['an export', after(locks, 'export GH_AW_MAX_AI_CREDITS="5000"'), per, /outside gh-aw's template/],
      ['a flow-style admission env', { ...locks, implement: locks.implement.replace(/^ {2}agent:\s*$/m, '  agent:\n    env: { GH_AW_ADMISSION_RESULT: admitted, GH_AW_ADMISSION_MAX_AI_CREDITS: "99999" }') }, per, /outside gh-aw's template/],
      ['a multiline GITHUB_ENV admission', after(locks, 'printf "GH_AW_ADMISSION_RESULT<<E\\nadmitted\\nE\\n" >> "$GITHUB_ENV"'), per, /outside gh-aw's template/],
      ['a duplicate maxAiCredits key in the config (last wins)', { ...locks, implement: locks.implement.replace('\\"maxAiCredits\\":${GH_AW_MAX_AI_CREDITS},', '\\"maxAiCredits\\":${GH_AW_MAX_AI_CREDITS},\\"maxAiCredits\\":5000,') }, per, /outside gh-aw's template/],
      ['a second config line with a literal cap', after(locks, `printf '%s\\n' "{\\"apiProxy\\":{\\"maxAiCredits\\":5000}}" > "\${RUNNER_TEMP}/gh-aw/awf-config.json"`), per, /outside gh-aw's template/],
      // Copilot review of #156: a pipeline before the redirect, and a key spelled with a JSON escape.
      ['a pipeline rewrites the config', { ...locks, implement: locks.implement.replace('}" > "${RUNNER_TEMP}/gh-aw/awf-config.json"', `}" | sed 's/500/5000/g' > "\${RUNNER_TEMP}/gh-aw/awf-config.json"`) }, per, /outside gh-aw's template/],
      ['a unicode-escaped duplicate key', { ...locks, implement: locks.implement.replace('\\"maxAiCredits\\":${GH_AW_MAX_AI_CREDITS},', '\\"maxAiCredits\\":${GH_AW_MAX_AI_CREDITS},\\"maxAi\\\\u0043redits\\":5000,') }, per, /outside gh-aw's template/],
      ['a unicode-escaped key in a second config write', after(locks, `printf '%s\\n' "{\\"apiProxy\\":{\\"maxAi\\\\u0043redits\\":5000}}" > "\${RUNNER_TEMP}/gh-aw/awf-config.json"`), per, /outside gh-aw's template/],
      ['a non-integer cap 500.5', { ...locks, implement: agentCap(locks.implement, '500.5') }, per, /agent cap 500\.5/],
      ['an exponent cap 500e2 (= 50000)', { ...locks, implement: agentCap(locks.implement, '500e2') }, per, /agent cap 50000/],
      ['a lock that cannot be read', { ...locks, repair: null }, per, /repair\.lock\.yml could not be read/],
      ['policy raises implement to 700', locks, { ...per, implement: 700 }, /agent cap 500(,500)* ≠ per_run\.implement 700/],
      ['policy lowers threat_detection', locks, { ...per, threat_detection: 300 }, /detection cap 400(,400)* ≠ per_run\.threat_detection 300/],
    ];
    for (const [what, l, p, re] of cases) assert.match(String(lockCapsMismatch(l, p)), re, what);
  });

  it('reads the pre-v1 format too (runs compiled by gh-aw v0.92 inline "maxAiCredits":N)', async () => {
    const per = (await testPolicies()).budgets.per_run;
    const legacy = (agent: number, evals?: number) =>
      `  agent:\n    run: '{"maxAiCredits":${agent}}'\n  detection:\n    run: '{"maxAiCredits":400}'\n${evals === undefined ? '' : `  evals:\n    run: '{"maxAiCredits":${evals}}'\n`}`;
    const l = { implement: legacy(500, 500), repair: legacy(300), review: legacy(200), improve: legacy(500), triage: null };
    assert.equal(lockCapsMismatch(l, per), null);
    assert.match(String(lockCapsMismatch({ ...l, implement: legacy(600, 500) }, per)), /implement\.lock\.yml agent cap 600/);
    assert.match(String(lockCapsMismatch({ ...l, implement: legacy(500, 600) }, per)), /implement\.lock\.yml evals cap 600/);
  });

  // gh-aw v1.0.1's evals job inherits max-ai-credits; spend.ts reserves and bounds it (EVALS_WORKFLOWS).
  it('the evals job: implement (if present) must cap it at per_run.implement; any other workflow must not have one', async () => {
    const per = (await testPolicies()).budgets.per_run;
    const locks = await read();
    // gh-aw v1.2 runs evals outside the firewall, without a cap: implement and v2-port no longer have
    // evals (#564), and the committed implement lock verifies without one (it spends less than reserved).
    assert.equal(/^ {2}evals:\s*$/m.test(locks.implement), false, 'implement.lock.yml has no evals job');
    assert.equal(lockCapsMismatch(locks, per), null);
    // A firewalled evals job (gh-aw v1.0.1's shape), modelled on implement's detection job.
    const start = locks.implement.search(/^ {2}detection:\s*$/m);
    assert.ok(start > 0, 'implement.lock.yml has a detection job');
    const next = start + 1 + locks.implement.slice(start + 1).search(/^ {2}[a-z_][a-z0-9_-]*:\s*$/m);
    const detection = locks.implement.slice(start, next);
    const withEvals = (cap: string) => `${locks.implement}\n${detection.replace(/^ {2}detection:/, '  evals:').replaceAll(`GH_AW_MAX_AI_CREDITS="${per.threat_detection}"`, `GH_AW_MAX_AI_CREDITS="${cap}"`)}`;
    assert.equal(lockCapsMismatch({ ...locks, implement: withEvals(String(per.implement)) }, per), null, 'evals capped at per_run.implement');
    const cases: [string, Record<CappedWorkflow, string | null>, RegExp][] = [
      ['evals cap 900 in implement', { ...locks, implement: withEvals('900') }, /implement\.lock\.yml evals cap 900(,900)* ≠ per_run\.implement 500/],
      ['evals job without the firewall cap (gh-aw v1.2)', { ...locks, implement: `${locks.implement}\n  evals:\n    runs-on: ubuntu-latest\n` }, /implement\.lock\.yml evals cap missing/],
      ['an evals job in repair', { ...locks, repair: `${locks.repair}\n  evals:\n    runs-on: ubuntu-latest\n` }, /repair\.lock\.yml has an evals job the controller doesn't reserve/],
    ];
    for (const [what, l, re] of cases) assert.match(String(lockCapsMismatch(l, per)), re, what);
  });
});

describe('write allowlist: the factory:alert issue', async () => {
  const { assertAllowedRequest, ALERT_TITLE, COMMENT_MARKER } = await import('../github.ts');
  const REPO = 'sabbasi3-factory-lab/chrono-node-rs';
  const ok = (body: unknown, mode: 'live' | 'dry-run' = 'live') => {
    try {
      assertAllowedRequest(REPO, 'POST', `/repos/${REPO}/issues`, body, mode);
      return true;
    } catch {
      return false;
    }
  };
  const good = { title: ALERT_TITLE('lock_caps_mismatch'), body: `${COMMENT_MARKER} · factory:alert\n\nx`, labels: ['factory:alert'] };
  it('live allows exactly a templated alert issue; nothing else', () => {
    assert.equal(ok(good), true);
    assert.equal(ok({ ...good, title: ALERT_TITLE('overshoot_assumption_exceeded') }), true);
    assert.equal(ok(good, 'dry-run'), false);
    for (const bad of [
      { ...good, title: 'Factory alert: anything' },
      { ...good, labels: ['factory:alert', 'factory:ready'] },
      { ...good, labels: ['factory:task'] },
      { ...good, body: 'no marker' },
      { ...good, body: `${COMMENT_MARKER} ${'x'.repeat(2000)}` },
      { ...good, assignees: ['someone'] },
    ]) {
      assert.equal(ok(bad), false, JSON.stringify(bad).slice(0, 80));
    }
  });
});
