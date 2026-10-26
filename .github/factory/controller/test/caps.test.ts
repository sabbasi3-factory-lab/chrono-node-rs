import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { testPolicies } from './helpers.ts';

// The spend collector counts a completed run whose usage is missing at its reservation:
// budgets.yaml per_run.<workflow> + per_run.threat_detection. That is a real upper bound only if
// each compiled workflow enforces exactly those caps, with no repository variable able to raise
// them (gh-aw: max-ai-credits "provides a hard stop" per run).
const wf = (name: string) => readFile(new URL(`../../../workflows/${name}.lock.yml`, import.meta.url), 'utf8');

describe('the spend bound is real: compiled caps equal the reservations', () => {
  const p = testPolicies();
  for (const [file, cap] of [['implement', 'implement'], ['repair', 'repair'], ['review', 'reviewer_agent']] as const) {
    it(`${file}.lock.yml: agent max-ai-credits = per_run.${cap}; detection = per_run.threat_detection, pinned`, async () => {
      const text = await wf(file);
      const budgets = (await p).budgets.per_run;
      const agentCaps = [...text.matchAll(/GH_AW_MAX_AI_CREDITS: "(\d+)"/g)].map((m) => Number(m[1]));
      assert.ok(agentCaps.length > 0, 'agent cap present');
      assert.ok(agentCaps.every((c) => c === budgets[cap]), `agent caps ${agentCaps} = ${budgets[cap]}`);
      const detection = [...text.matchAll(/"maxAiCredits":(\d+)/g)].map((m) => Number(m[1]));
      assert.ok(detection.includes(budgets.threat_detection), `detection maxAiCredits ${detection}`);
      assert.doesNotMatch(text, /GH_AW_DEFAULT_DETECTION_MAX_AI_CREDITS|GH_AW_DEFAULT_MAX_AI_CREDITS/, 'no variable can raise a cap');
      assert.doesNotMatch(text, /max-ai-credits: -1|"maxAiCredits":-/, 'enforcement not disabled');
    });
  }
});
