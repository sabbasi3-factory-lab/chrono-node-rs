import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { FACTORY_REPO, loadPolicies, parseFactoryVersion, parsePolicies, policyUrl, POLICY_NAMES, readFactoryVersion, type PolicyTexts } from '../policies.ts';

const SHA = 'db6444d4f30155ff7671159908127c7e861b07a4';
const dir = new URL('./fixtures/policies/', import.meta.url);

async function texts(): Promise<PolicyTexts> {
  const out: Partial<PolicyTexts> = {};
  for (const n of POLICY_NAMES) out[n] = await readFile(new URL(`${n}.yaml`, dir), 'utf8');
  return out as PolicyTexts;
}

describe('policies', () => {
  it('parses the pinned policy files', async () => {
    const p = parsePolicies(await texts());
    assert.equal(p.limits.wip.start, 3);
    assert.equal(p.limits.wip.max, 10);
    assert.equal(p.limits.wip.adaptive.pause_dispatch_when_busy_jobs_over, 14);
    assert.equal(p.limits.wip.core_area, 1);
    assert.equal(p.limits.task.max_repairs, 2);
    assert.equal(p.limits.task.max_wall_clock_hours, 24);
    assert.equal(p.limits.human_queue.max_items, 5);
    assert.equal(p.budgets.factory_per_day.max_aic, 10000);
    assert.equal(p.budgets.factory_per_day.alert_at_pct, 80);
    assert.equal(p.budgets.factory_per_day.pause_at_pct, 100);
    assert.equal(p.tiers.tiers['auto-strict'].start_as, 'human');
    assert.deepEqual(p.tiers.tiers['auto-strict'].strict_gates, ['full_regression', 'semver_checks', 'mutation_score_not_lower', 'perf_regression_max_pct', 'code_health_not_worse', 'reviewer_agent', 'serialize_area', 'auto_revert_on_regression']);
    assert.equal(p.cadence.heartbeat, 'hourly');
    assert.equal(p.limits.auto_ready, true, 'turned on by the owner (factory#15)');
  });

  it('strict_gates: names (a `name: value` entry by its name); missing or malformed → null, never a load failure', async () => {
    const t = await texts();
    const gates = (yaml: string) => parsePolicies({ ...t, tiers: t.tiers.replace(/    strict_gates:\n(?:      - .*\n)+/, yaml) }).tiers.tiers['auto-strict'].strict_gates;
    assert.deepEqual(gates('    strict_gates:\n      - a\n      - b: 5\n'), ['a', 'b']);
    assert.deepEqual(gates('    strict_gates: []\n'), []);
    for (const bad of ['', '    strict_gates: x\n', '    strict_gates:\n      - 3\n', '    strict_gates:\n      - {a: 1, b: 2}\n', '    strict_gates:\n      - ""\n']) {
      assert.equal(gates(bad), null, JSON.stringify(bad));
    }
  });

  it('builds raw URLs at the pinned SHA only', () => {
    assert.equal(policyUrl(SHA, 'limits'), `https://raw.githubusercontent.com/${FACTORY_REPO}/${SHA}/policies/limits.yaml`);
    assert.throws(() => policyUrl('main', 'limits'), /full commit SHA/);
  });

  it('auto_ready is on only for an explicit `true` (missing, false, "true" or 1 → off)', async () => {
    const t = await texts();
    const without = t.limits.replace(/^auto_ready:.*\n/m, '');
    assert.ok(!/auto_ready:/.test(without));
    assert.equal(parsePolicies({ ...t, limits: without }).limits.auto_ready, false, 'missing');
    for (const [v, want] of [['true', true], ['false', false], ['"true"', false], ['1', false], ['yes', false]] as const) {
      assert.equal(parsePolicies({ ...t, limits: `${without}\nauto_ready: ${v}\n` }).limits.auto_ready, want, v);
    }
  });

  it('fails closed on missing or wrongly typed fields', async () => {
    const t = await texts();
    assert.throws(() => parsePolicies({ ...t, limits: t.limits.replace('max_repairs: 2', 'max_repairs: two') }), /max_repairs/);
    assert.throws(() => parsePolicies({ ...t, budgets: t.budgets.replace(/factory_per_day:[\s\S]*$/, '') }), /factory_per_day/);
    assert.throws(() => parsePolicies({ ...t, tiers: 'version: 2\n' }), /unsupported version/);
    assert.throws(() => parsePolicies({ ...t, limits: t.limits.replace('fail_closed: true', 'fail_closed: false') }), /fail_closed/);
    assert.throws(() => parsePolicies({ ...t, cadence: '' }), /not a mapping/);
  });

  it('fails closed when a policy cannot be fetched', async () => {
    const t = await texts();
    const seen: string[] = [];
    const fetchFn = async (url: string) => {
      seen.push(url);
      const name = url.split('/').pop()!.replace('.yaml', '') as keyof PolicyTexts;
      return name === 'tiers' ? { ok: false, status: 404, text: async () => '' } : { ok: true, status: 200, text: async () => t[name] };
    };
    await assert.rejects(loadPolicies(SHA, fetchFn), /tiers: HTTP 404/);
    assert.ok(seen.every((u) => u.includes(`/${SHA}/policies/`)));
    await assert.rejects(loadPolicies(SHA, async () => { throw new Error('offline'); }), /offline/);
  });

  it('loads when all files are served', async () => {
    const t = await texts();
    const p = await loadPolicies(SHA, async (url) => ({ ok: true, status: 200, text: async () => t[url.split('/').pop()!.replace('.yaml', '') as keyof PolicyTexts] }));
    assert.equal(p.limits.wip.start, 3);
  });

  it('reads the factory-version file strictly', async () => {
    assert.equal(await readFactoryVersion(new URL('../../factory-version', import.meta.url)), SHA);
    assert.equal(parseFactoryVersion(`${SHA}\n`), SHA);
    assert.equal(parseFactoryVersion(SHA), SHA);
    for (const bad of ['main\n', `${SHA.slice(0, 7)}\n`, `${SHA}\n${SHA}\n`, ` ${SHA}\n`, `${SHA.toUpperCase()}\n`, '']) {
      assert.throws(() => parseFactoryVersion(bad), /factory-version/);
    }
  });
});
