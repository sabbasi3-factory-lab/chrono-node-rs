import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { intakeFixOf } from '../github.ts';
import { plan } from '../planner.ts';
import { loadPoliciesFromDir } from '../policies.ts';
import type { Decision, Policies, PullSnap } from '../types.ts';
import { checkRun, hex40, NOW, pull, snapshot, testPolicies } from './helpers.ts';

const base = await testPolicies();
const ON: { FACTORY_ENABLED: string | undefined } = { FACTORY_ENABLED: 'true' };
const none: Policies = { ...base, tiers: { ...base.tiers, intake_fixes: null } };
const withIntake = (auto_merge = true, max_per_day = 3): Policies => ({ ...base, tiers: { ...base.tiers, intake_fixes: { auto_merge, max_per_day } } });
const kinds = (ds: Decision[]) => ds.map((d) => `${d.type}/${d.reason}`);
const FIX = 'en/fix-0123abcd';
const FILES = [
  { path: 'contracts/en/fix-0123abcd.yaml', status: 'added' },
  { path: 'harness/golden/fixes/en-fix-0123abcd.json', status: 'added' },
  { path: 'tests/golden/fixes/en-fix-0123abcd.json', status: 'added' },
];
const HEAD = hex40('5');
const intakePr = (n = 40, over: Partial<PullSnap> = {}): PullSnap =>
  pull(n, {
    task_id: null,
    contract_sha: null,
    attempt: null,
    author: 'sabbasi3-factory-controller[bot]',
    author_is_bot: true,
    head_ref: 'factory/intake/en-fix-0123abcd',
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
      checkRun(960, { head_sha: pr.head_sha, pull_requests: [pr.number], conclusion: ci }),
      checkRun(961, { workflow: 'gates', event: 'pull_request_target', head_sha: hex40('e'), candidate_sha: pr.head_sha, conclusion: gates }),
    ],
  });
const run = (s: ReturnType<typeof world>, p = withIntake(), env = ON) => plan(s, p, env, NOW);

describe('bug-intake fix PRs (tiers.yaml intake_fixes)', () => {
  it('intakeFixOf: the intake branch by the controller App only', () => {
    assert.equal(intakeFixOf(intakePr()), FIX);
    assert.equal(intakeFixOf(intakePr(40, { author: 'sabbasi3', author_is_bot: false })), null);
    assert.equal(intakeFixOf(intakePr(40, { author: 'sabbasi3-factory-agent[bot]' })), null);
    assert.equal(intakeFixOf(intakePr(40, { head_ref: 'factory/intake/en-fix-0123abcd-x' })), null);
    assert.equal(intakeFixOf(intakePr(40, { head_ref: 'factory/revert-12' })), null);
  });

  it('adds exactly its three files, ci and gates green → auto_merge/intake_fix_ready on that head', () => {
    const ds = run(world(intakePr()));
    assert.deepEqual(kinds(ds), ['auto_merge/intake_fix_ready']);
    assert.deepEqual([ds[0]!.effect, ds[0]!.head_sha, ds[0]!.task], ['enqueue_merge', HEAD, null]);
  });

  it('without the policy (absent, or auto_merge: false) the owner merges: nothing planned', () => {
    assert.deepEqual(kinds(run(world(intakePr()), none)), []);
    assert.deepEqual(kinds(run(world(intakePr()), withIntake(false))), []);
  });

  it('anything but adding exactly those files → needs_human/intake_fix_not_additive', () => {
    const cases: [string, PullSnap['files']][] = [
      ['an edited golden file', [...FILES.slice(0, 2), { path: 'tests/golden/fixes/en-fix-0123abcd.json', status: 'modified' }]],
      ['a removed contract', [...FILES, { path: 'contracts/en/weekday-parser.yaml', status: 'removed' }]],
      ['an extra source file', [...FILES, { path: 'src/locales/en/parsers/weekday.rs', status: 'added' }]],
      ['another fix id', FILES.map((f) => ({ ...f, path: f.path.replace('0123abcd', '0123abce') }))],
      ['a file missing', FILES.slice(0, 2)],
      ['a rename', [...FILES.slice(0, 2), { path: 'tests/golden/fixes/en-fix-0123abcd.json', status: 'renamed' }]],
    ];
    for (const [what, files] of cases) assert.deepEqual(kinds(run(world(intakePr(40, { files })))), ['needs_human/intake_fix_not_additive'], what);
  });

  it('files unreadable, checks pending or not mergeable → wait (nothing); checks failed → needs_human', () => {
    assert.deepEqual(kinds(run(world(intakePr(40, { files: null })))), []);
    assert.deepEqual(kinds(run(world(intakePr(), 'success', 'in_progress' as string))), []);
    assert.deepEqual(kinds(run(world(intakePr(40, { mergeable: 'CONFLICTING' })))), []);
    assert.deepEqual(kinds(run(world(intakePr(), 'failure'))), ['needs_human/intake_fix_checks_failed']);
    assert.deepEqual(kinds(run(world(intakePr(), 'success', 'failure'))), ['needs_human/intake_fix_checks_failed']);
  });

  it('at most max_per_day a day (merged today or in the queue count); above that the owner decides', () => {
    const merged = (n: number, at: string) => intakePr(n, { state: 'merged', merged_at: at, head_ref: `factory/intake/en-fix-0000000${n % 10}` });
    const today = NOW.toISOString().slice(0, 10);
    const two = [merged(31, `${today}T01:00:00Z`), merged(32, `${today}T02:00:00Z`)];
    assert.deepEqual(kinds(run(world(intakePr(), 'success', 'success', two))), ['auto_merge/intake_fix_ready'], '2 today: the 3rd goes');
    const three = [...two, intakePr(33, { head_ref: 'factory/intake/en-fix-00000003', in_merge_queue: true })];
    assert.deepEqual(kinds(run(world(intakePr(), 'success', 'success', three))), ['needs_human/intake_fix_daily_cap'], '3 today: the owner');
    const yesterday = [merged(31, '2026-10-15T23:00:00Z'), merged(32, '2026-10-15T23:30:00Z'), merged(34, '2026-10-15T23:45:00Z')];
    assert.deepEqual(kinds(run(world(intakePr(), 'success', 'success', yesterday))), ['auto_merge/intake_fix_ready'], "yesterday's don't count");
    assert.deepEqual(kinds(run(world(intakePr()), withIntake(true, 0))), ['needs_human/intake_fix_daily_cap']);
  });

  it('a person-merged or other-author PR on an intake branch never counts as ours; the kill switch holds the merge', () => {
    assert.deepEqual(kinds(run(world(intakePr(40, { author: 'sabbasi3', author_is_bot: false })))), []);
    assert.deepEqual(kinds(run(world(intakePr()), withIntake(), { FACTORY_ENABLED: undefined } as { FACTORY_ENABLED: string | undefined })), ['kill_switch/kill_switch']);
  });

  it('left the queue unmerged → needs_human/merge_queue_rejected; draft or needs-human → nothing', () => {
    const removed = intakePr(40, { merge_queue_events: [{ node_id: 'RMQ_9', kind: 'dequeued', created_at: '2026-10-16T11:00:00Z', actor: 'github-merge-queue', reason: 'failed checks' }] });
    assert.deepEqual(kinds(run(world(removed))), ['needs_human/merge_queue_rejected']);
    assert.deepEqual(kinds(run(world(intakePr(40, { draft: true })))), []);
    assert.deepEqual(kinds(run(world(intakePr(40, { labels: ['needs-human'] })))), []);
  });
});

describe('tiers.yaml intake_fixes parsing', () => {
  it('the pinned policy enables it (3 a day); absent → null; malformed → fails closed', async () => {
    assert.deepEqual(base.tiers.intake_fixes, { auto_merge: true, max_per_day: 3 });
    const { mkdtemp, readdir, readFile, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const src = new URL('./fixtures/policies/', import.meta.url);
    const dir = await mkdtemp(`${tmpdir()}/policies-`);
    for (const f of await readdir(src)) await writeFile(`${dir}/${f}`, await readFile(new URL(f, src), 'utf8'));
    const tiers = (await readFile(new URL('tiers.yaml', src), 'utf8')).replace(/^intake_fixes:\n(  .*\n)+/m, '');
    assert.doesNotMatch(tiers, /intake_fixes/);
    const load = async (extra: string) => {
      await writeFile(`${dir}/tiers.yaml`, `${tiers}\n${extra}\n`);
      return loadPoliciesFromDir(new URL(`file://${dir}/`));
    };
    assert.equal((await load('')).tiers.intake_fixes, null);
    assert.deepEqual((await load('intake_fixes:\n  auto_merge: true\n  max_per_day: 3')).tiers.intake_fixes, { auto_merge: true, max_per_day: 3 });
    await assert.rejects(load('intake_fixes:\n  auto_merge: yes-please\n  max_per_day: 3'), /intake_fixes/);
    await assert.rejects(load('intake_fixes:\n  auto_merge: true\n  max_per_day: 100'), /max_per_day/);
  });
});
