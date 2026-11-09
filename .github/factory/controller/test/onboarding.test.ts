import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { onboardingOf } from '../github.ts';
import { onboardingFilesOk, plan } from '../planner.ts';
import { parsePolicies } from '../policies.ts';
import { readFile } from 'node:fs/promises';
import type { Decision, Policies, PullSnap } from '../types.ts';
import { checkRun, hex40, NOW, pull, snapshot, testPolicies } from './helpers.ts';

const base = await testPolicies();
const ON: { FACTORY_ENABLED: string | undefined } = { FACTORY_ENABLED: 'true' };
const withOnboarding = (auto_merge = true, max_per_day = 1): Policies => ({ ...base, tiers: { ...base.tiers, onboarding: { auto_merge, max_per_day } } });
const kinds = (ds: Decision[]) => ds.map((d) => `${d.type}/${d.reason}`);
const FILES = [
  ...['locale.json', 'mod.rs', 'configuration.rs', 'parsers/.gitkeep', 'refiners/.gitkeep'].map((f) => ({ path: `src/locales/fi/${f}`, status: 'added' })),
  { path: 'scripts/seed-backlog/taskmap.d/fi.yaml', status: 'added' },
  { path: 'harness/golden/coverage/fi.json', status: 'added' },
  { path: 'tests/golden/fi/casual.json', status: 'added' },
  { path: 'tests/golden/fi/coverage.json', status: 'added' },
  { path: 'contracts/fi/constants.yaml', status: 'added' },
  { path: 'contracts/fi/weekday-parser.yaml', status: 'added' },
  { path: 'tests/golden/index.json', status: 'modified' },
  { path: 'tests/golden/configurations.json', status: 'modified' },
];
const HEAD = hex40('6');
const onboardPr = (n = 50, over: Partial<PullSnap> = {}): PullSnap =>
  pull(n, {
    task_id: null,
    contract_sha: null,
    attempt: null,
    author: 'sabbasi3-factory-controller[bot]',
    author_is_bot: true,
    head_ref: 'factory/onboard/fi',
    head_sha: HEAD,
    mergeable: 'MERGEABLE',
    in_merge_queue: false,
    files: FILES,
    ...over,
  });
const world = (pr: PullSnap, ci = 'success', gates = 'success', extra: PullSnap[] = []) =>
  snapshot({
    pulls: [pr, ...extra],
    check_runs: [
      checkRun(970, { head_sha: pr.head_sha, pull_requests: [pr.number], conclusion: ci }),
      checkRun(971, { workflow: 'gates', event: 'pull_request_target', head_sha: hex40('e'), candidate_sha: pr.head_sha, pull_requests: [pr.number], conclusion: gates }),
    ],
  });
const run = (s: ReturnType<typeof world>, p = withOnboarding(), env = ON) => plan(s, p, env, NOW);

describe('generated language-onboarding PRs (tiers.yaml onboarding)', () => {
  it('onboardingOf: the onboarding branch by the controller App only', () => {
    assert.equal(onboardingOf(onboardPr()), 'fi');
    assert.equal(onboardingOf(onboardPr(50, { head_ref: 'factory/onboard/zh-hans' })), 'zh-hans');
    assert.equal(onboardingOf(onboardPr(50, { author: 'sabbasi3', author_is_bot: false })), null);
    assert.equal(onboardingOf(onboardPr(50, { author: 'sabbasi3-factory-agent[bot]' })), null);
    assert.equal(onboardingOf(onboardPr(50, { head_ref: 'factory/onboard/fi/x' })), null);
  });

  it('exactly the generator output, ci and gates green → auto_merge/onboarding_ready on that head', () => {
    const ds = run(world(onboardPr()));
    assert.deepEqual(kinds(ds), ['auto_merge/onboarding_ready']);
    assert.deepEqual([ds[0]!.effect, ds[0]!.head_sha, ds[0]!.task], ['enqueue_merge', HEAD, null]);
  });

  it('without the policy (absent, or auto_merge: false) the owner merges: nothing planned', () => {
    assert.deepEqual(kinds(run(world(onboardPr()), base)), []);
    assert.deepEqual(kinds(run(world(onboardPr()), withOnboarding(false))), []);
  });

  it('anything but the generator output → needs-human (onboarding_not_generated)', () => {
    const shapes: { path: string; status: string }[][] = [
      [...FILES, { path: 'harness/onboard/lib.js', status: 'modified' }],
      [...FILES, { path: 'contracts/de/weekday-parser.yaml', status: 'modified' }],
      [...FILES, { path: 'contracts/sv/new.yaml', status: 'added' }],
      FILES.map((f) => (f.path === 'tests/golden/fi/casual.json' ? { ...f, status: 'modified' } : f)),
      FILES.filter((f) => f.path !== 'src/locales/fi/configuration.rs'),
      FILES.filter((f) => f.path !== 'tests/golden/index.json'),
      FILES.filter((f) => !f.path.startsWith('contracts/')),
      [...FILES, { path: '', status: 'too_many' }],
      [...FILES, { path: 'src/locales/fi/parsers/weekday.rs', status: 'added' }],
      [...FILES, { path: 'src/locales/fi/constants.rs', status: 'added' }],
      FILES.filter((f) => f.path !== 'src/locales/fi/refiners/.gitkeep'),
      [...FILES, { path: 'src/locales/fi/.gitkeep', status: 'added' }],
      [...FILES, { path: 'src/locales/fi/../de/.gitkeep', status: 'added' }],
      [...FILES, { path: 'src/locales/de/parsers/.gitkeep', status: 'added' }],
    ];
    for (const files of shapes) {
      assert.equal(onboardingFilesOk('fi', files), false, JSON.stringify(files.at(-1)));
      assert.deepEqual(kinds(run(world(onboardPr(50, { files })))), ['needs_human/onboarding_not_generated']);
    }
    // Another code's branch with this code's files.
    assert.deepEqual(kinds(run(world(onboardPr(50, { head_ref: 'factory/onboard/nl' })))), ['needs_human/onboarding_not_generated']);
    // zh-hans: module zh_hans, contracts under zh-hans.
    const zh = FILES.map((f) => ({ ...f, path: f.path.replace('/fi/', '/zh_hans/').replace('fi.json', 'zh_hans.json').replace('fi.yaml', 'zh_hans.yaml').replace('contracts/zh_hans/', 'contracts/zh-hans/') }));
    assert.equal(onboardingFilesOk('zh-hans', zh), true);
  });

  it('unread files, pending checks or a conflict → wait; failed checks → needs-human', () => {
    assert.deepEqual(kinds(run(world(onboardPr(50, { files: null })))), []);
    assert.deepEqual(kinds(run(world(onboardPr(), 'in_progress' as string))).filter((k) => !k.startsWith('wait')), []);
    assert.deepEqual(kinds(run(world(onboardPr(50, { mergeable: 'CONFLICTING' })))), []);
    assert.deepEqual(kinds(run(world(onboardPr(), 'failure'))), ['needs_human/onboarding_checks_failed']);
    assert.deepEqual(kinds(run(world(onboardPr(), 'success', 'failure'))), ['needs_human/onboarding_checks_failed']);
  });

  it('the daily cap counts merged-today and queued onboarding PRs; the kill switch holds the enqueue', () => {
    const merged = onboardPr(49, { state: 'MERGED' as PullSnap['state'], merged_at: NOW.toISOString(), head_ref: 'factory/onboard/id' });
    assert.deepEqual(kinds(run(world(onboardPr(), 'success', 'success', [merged]))), ['needs_human/onboarding_daily_cap']);
    assert.deepEqual(kinds(run(world(onboardPr(), 'success', 'success', [merged]), withOnboarding(true, 2))), ['auto_merge/onboarding_ready']);
    assert.deepEqual(kinds(run(world(onboardPr()), withOnboarding(true, 0))), ['needs_human/onboarding_daily_cap']);
    assert.ok(!kinds(run(world(onboardPr()), withOnboarding(), { FACTORY_ENABLED: undefined })).includes('auto_merge/onboarding_ready'));
  });

  it('policy: tiers.yaml `onboarding` absent → null; malformed → the policy fails to load', async () => {
    const dir = new URL('./fixtures/policies/', import.meta.url);
    const t = Object.fromEntries(await Promise.all(['limits', 'budgets', 'tiers', 'cadence', 'onboarding'].map(async (n) => [n, await readFile(new URL(`${n}.yaml`, dir), 'utf8')])));
    const tiers = (extra: string) => ({ ...t, tiers: `${t.tiers}\n${extra}\n` }) as Parameters<typeof parsePolicies>[0];
    assert.equal(parsePolicies(t as Parameters<typeof parsePolicies>[0]).tiers.onboarding, null);
    assert.deepEqual(parsePolicies(tiers('onboarding: { auto_merge: true, max_per_day: 1 }')).tiers.onboarding, { auto_merge: true, max_per_day: 1 });
    assert.throws(() => parsePolicies(tiers('onboarding: { auto_merge: yes-please, max_per_day: 1 }')));
    assert.throws(() => parsePolicies(tiers('onboarding: { auto_merge: true, max_per_day: 6 }')));
  });

  it("only this PR's own runs count: another PR's green ci at the same commit doesn't (review fix)", () => {
    const s = world(onboardPr(), 'failure');
    s.check_runs.push(checkRun(980, { head_sha: HEAD, pull_requests: [77], conclusion: 'success' }));
    assert.deepEqual(kinds(run(s)), ['needs_human/onboarding_checks_failed']);
    const pending = world(onboardPr());
    pending.check_runs = pending.check_runs.map((r) => (r.run_id === 970 ? { ...r, pull_requests: [77] } : r));
    assert.deepEqual(kinds(run(pending)), []);
  });

  it('with the kill switch off, a second ready PR is not handed to a person for the daily cap (review fix)', () => {
    const second = onboardPr(51, { head_ref: 'factory/onboard/id', head_sha: hex40('7'), node_id: 'PR_51', files: FILES.map((f) => ({ ...f, path: f.path.replace(/\bfi\b/g, 'id') })) });
    const s = world(onboardPr(), 'success', 'success', [second]);
    s.check_runs.push(checkRun(972, { head_sha: second.head_sha, pull_requests: [51], conclusion: 'success' }), checkRun(973, { workflow: 'gates', event: 'pull_request_target', head_sha: hex40('e'), candidate_sha: second.head_sha, pull_requests: [51], conclusion: 'success' }));
    assert.ok(!kinds(run(s, withOnboarding(), { FACTORY_ENABLED: undefined })).includes('needs_human/onboarding_daily_cap'));
    assert.deepEqual(kinds(run(s)).filter((k) => !k.startsWith('wait')).sort(), ['auto_merge/onboarding_ready', 'needs_human/onboarding_daily_cap']);
  });
});
