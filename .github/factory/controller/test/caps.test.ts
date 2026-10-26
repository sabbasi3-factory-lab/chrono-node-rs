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
  it('the committed locks enforce exactly budgets.yaml per_run (agent job and detection job, no variables)', async () => {
    assert.equal(lockCapsMismatch(await read(), (await testPolicies()).budgets.per_run), null);
  });

  it('any drift is a mismatch: agent cap, detection cap, a variable override, a missing lock, a policy change', async () => {
    const per = (await testPolicies()).budgets.per_run;
    const locks = await read();
    const agentStart = locks.implement.search(/^ {2}agent:\s*$/m);
    const detStart = locks.implement.search(/^ {2}detection:\s*$/m);
    assert.ok(agentStart > 0 && detStart > agentStart);
    const cases: [string, Record<CappedWorkflow, string | null>, typeof per, RegExp][] = [
      ['agent cap 600 in implement', { ...locks, implement: locks.implement.slice(0, detStart).replace('"maxAiCredits":500', '"maxAiCredits":600') + locks.implement.slice(detStart) }, per, /implement\.lock\.yml agent cap 600/],
      ['detection cap 450 in repair', { ...locks, repair: locks.repair.replace(/("maxAiCredits":)400(?![\s\S]*"maxAiCredits":400)/, '$1450') }, per, /repair\.lock\.yml detection cap 450/],
      ['a variable can set a cap', { ...locks, review: `${locks.review}\n# \${{ vars.GH_AW_DEFAULT_DETECTION_MAX_AI_CREDITS }}\n` }, per, /lets a variable set/],
      ['a lock that cannot be read', { ...locks, repair: null }, per, /repair\.lock\.yml could not be read/],
      ['policy raises implement to 700', locks, { ...per, implement: 700 }, /agent cap 500 ≠ per_run\.implement 700/],
      ['policy lowers threat_detection', locks, { ...per, threat_detection: 300 }, /detection cap 400 ≠ per_run\.threat_detection 300/],
    ];
    for (const [what, l, p, re] of cases) assert.match(String(lockCapsMismatch(l, p)), re, what);
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
