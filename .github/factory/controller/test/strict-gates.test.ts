import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { CI_STRICT_GATE_STEPS, CONTROLLER_STRICT_GATES, FULL_REGRESSION_STEP } from '../github.ts';
import { IMPLEMENTED_STRICT_GATES } from '../planner.ts';

const STRICT_IF = "steps.scope.outputs.strict == 'true'";

describe('strict gates: every implemented gate is enforced somewhere', () => {
  it('each implemented gate is a ci step or a controller gate, exactly once', () => {
    const ci = Object.keys(CI_STRICT_GATE_STEPS);
    assert.deepEqual([...IMPLEMENTED_STRICT_GATES].sort(), [...ci, ...CONTROLLER_STRICT_GATES].sort());
    assert.equal(new Set([...ci, ...CONTROLLER_STRICT_GATES]).size, ci.length + CONTROLLER_STRICT_GATES.length);
  });

  it('each ci gate step is in the checks job, gated exactly like the full regression, never continue-on-error', async () => {
    const wf = parse(await readFile(new URL('../../../workflows/ci.yml', import.meta.url), 'utf8')) as { jobs: Record<string, { steps: Record<string, unknown>[]; 'continue-on-error'?: unknown }> };
    assert.deepEqual(Object.keys(wf.jobs), ['checks'], 'one job: a green ci means every step passed');
    const job = wf.jobs.checks!;
    assert.equal(job['continue-on-error'], undefined);
    const steps = job.steps;
    for (const [gate, name] of Object.entries(CI_STRICT_GATE_STEPS)) {
      const matches = steps.filter((s) => s.name === name);
      assert.equal(matches.length, 1, `${gate}: exactly one step named ${name}`);
      const step = matches[0]!;
      assert.equal(step.if, STRICT_IF, `${gate}: same if: as the full regression`);
      assert.equal(step['continue-on-error'], undefined, `${gate}: never continue-on-error`);
      // Enforced on factory PRs (what auto-strict merges); a person's PRs and main are the owner's call.
      if (name !== FULL_REGRESSION_STEP) {
        assert.equal((step.env as Record<string, unknown> | undefined)?.KIND, '${{ steps.scope.outputs.kind }}', `${gate}: reads the PR kind`);
        const run = String(step.run);
        assert.ok(/"\$KIND" = "factory"/.test(run) || /^bash harness\/strict\/[a-z_-]+\.sh$/.test(run.trim()), `${gate}: enforces on factory PRs (inline, or in a harness/strict script)`);
      }
    }
    // Every step gated on strict is a gate step or its tool install.
    for (const s of steps.filter((x) => x.if === STRICT_IF)) {
      assert.ok(Object.values(CI_STRICT_GATE_STEPS).includes(s.name as string) || String(s.name).startsWith('Strict gate tools - '), String(s.name));
      assert.equal(s['continue-on-error'], undefined, String(s.name));
    }
    // The controller's evidence is the full regression step; with one job, one if: and no
    // continue-on-error, its success in a green run means every other gate step ran and passed.
    assert.ok(steps.some((s) => s.name === FULL_REGRESSION_STEP));
  });
});
