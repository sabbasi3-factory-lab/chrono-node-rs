import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { plan } from '../planner.ts';
import type { Decision, MergeQueueEventSnap, PlannerEnv, ReasonCode, Snapshot } from '../types.ts';
import { type SnapshotOverrides, checkRun, commitSha, contract, hex40, history, issue, mergedPull, NOW, pull, snapshot, testPolicies } from './helpers.ts';

const policies = await testPolicies();
const ON: PlannerEnv = { FACTORY_ENABLED: 'true' };

function run(s: Snapshot, env: PlannerEnv = ON, now = NOW): Decision[] {
  return plan(s, policies, env, now);
}
const reasons = (ds: Decision[]): ReasonCode[] => ds.map((d) => d.reason);
const find = (ds: Decision[], reason: ReasonCode): Decision => {
  const d = ds.find((x) => x.reason === reason);
  assert.ok(d, `expected a decision with reason ${reason}, got ${reasons(ds).join(',')}`);
  return d;
};

// A ready, admissible task with a merged dependency.
function readyWorld(over: SnapshotOverrides = {}, extraContracts = [contract('core/results', { scope: ['src/core/results.rs'] })]): Snapshot {
  return snapshot({
    issues: [issue(1, 'en/weekday-parser')],
    pulls: [mergedPull(100, 'core/results')],
    contractList: [contract('en/weekday-parser', { depends_on: ['core/results'] }), ...extraContracts],
    ...over,
  });
}

const PICKED_RECENTLY = '2026-10-16T10:00:00Z';
/** History for tasks picked two hours ago (a picked task without a pick time goes to needs_human). */
const pickedRecently = (tasks: string[]) => Object.fromEntries(tasks.map((t) => [t, history({ picked_at: PICKED_RECENTLY })]));
/** A completed trusted `gates` run for a PR head (pull_request_target: head_sha is the main tip). */
const gatesRun = (id: number, candidate: string, over = {}) =>
  checkRun(id, { workflow: 'gates', event: 'pull_request_target', head_sha: hex40('e'), candidate_sha: candidate, conclusion: 'success', ...over });

// An open factory PR for en/weekday-parser with a current Contract-SHA, green
// gates and a failed CI run, picked two hours ago.
function failingPrWorld(sig: string | null, h = history({ picked_at: PICKED_RECENTLY }), conclusion = 'failure'): Snapshot {
  const c = contract('en/weekday-parser');
  const pr = pull(21, { task_id: 'en/weekday-parser', contract_sha: c.last_commit_sha.slice(0, 7) });
  return snapshot({
    issues: [issue(1, 'en/weekday-parser', ['factory:picked'])],
    pulls: [pr],
    contractList: [c],
    check_runs: [gatesRun(490, pr.head_sha), checkRun(500, { head_sha: pr.head_sha, pull_requests: [21], conclusion, failure_signature: sig })],
    history: { 'en/weekday-parser': h },
  });
}

describe('planner: stage 0 and purity', () => {
  it('returns nothing for an empty repo (Stage 0)', () => {
    assert.deepEqual(run(snapshot()), []);
    assert.deepEqual(run(snapshot(), { FACTORY_ENABLED: undefined }), []);
  });

  it('is pure: same input → same output, and the snapshot is not mutated', () => {
    const s = readyWorld();
    const copy = structuredClone(s);
    assert.deepEqual(run(s), run(s));
    assert.deepEqual(s, copy);
  });

  it('marks every decision dry_run and gives each a reason code', () => {
    const ds = [...run(readyWorld()), ...run(failingPrWorld('golden:x')), ...run(readyWorld(), { FACTORY_ENABLED: 'false' })];
    assert.ok(ds.length > 0);
    for (const d of ds) {
      assert.equal(d.dry_run, true);
      assert.match(d.reason, /^[a-z_]+$/);
      assert.ok(d.source_ids.length > 0);
    }
  });
});

describe('planner: admit', () => {
  it('dispatches a ready task (would_dispatch) with the contract commit SHA', () => {
    const d = find(run(readyWorld()), 'would_dispatch');
    assert.equal(d.type, 'dispatched');
    assert.equal(d.effect, 'dispatch_workflow:implement');
    assert.equal(d.task, 'en/weekday-parser');
    assert.equal(d.issue, 1);
    assert.equal(d.attempt, 1);
    assert.equal(d.contract_sha, commitSha('en/weekday-parser'));
  });

  it('ignores issues without factory:ready', () => {
    const s = readyWorld({ issues: [issue(1, 'en/weekday-parser', ['proposed'])] });
    assert.deepEqual(run(s), []);
  });

  it('blocks a ready issue without a valid marker (missing_task_marker)', () => {
    const s = readyWorld({ issues: [issue(1, null), { ...issue(2, null), marker_status: 'invalid' }] });
    const ds = run(s);
    assert.deepEqual(reasons(ds), ['missing_task_marker', 'missing_task_marker']);
    assert.equal(ds[0]!.type, 'blocked');
  });

  it('blocks a second issue for the same task (duplicate_task)', () => {
    const s = readyWorld({ issues: [issue(1, 'en/weekday-parser'), issue(2, 'en/weekday-parser')] });
    const ds = run(s);
    assert.equal(find(ds, 'duplicate_task').issue, 2);
    assert.equal(find(ds, 'would_dispatch').issue, 1);
  });

  it('blocks when the contract is not on main (contract_missing)', () => {
    const s = readyWorld({ contractList: [] });
    const d = find(run(s), 'contract_missing');
    assert.equal(d.type, 'blocked');
  });

  it('blocks when the contract is invalid (invalid_contract)', () => {
    const s = readyWorld({ contractList: [contract('en/weekday-parser', { valid: false })] });
    assert.equal(find(run(s), 'invalid_contract').type, 'blocked');
  });

  it('waits until dependencies are merged (deps_not_merged)', () => {
    const s = readyWorld({ pulls: [pull(100, { task_id: 'core/results' })] });
    const ds = run(s);
    assert.equal(find(ds, 'deps_not_merged').type, 'wait');
    assert.ok(!ds.some((d) => d.type === 'dispatched'));
  });

  it('skips a task that is already merged (already_merged)', () => {
    const s = readyWorld({ pulls: [mergedPull(100, 'core/results'), mergedPull(101, 'en/weekday-parser')] });
    assert.deepEqual(reasons(run(s)).sort(), ['already_merged', 'task_merged']);
  });

  it('does not re-admit a task that is in flight', () => {
    const s = readyWorld({ issues: [issue(1, 'en/weekday-parser', ['factory:ready', 'factory:picked'])], history: pickedRecently(['en/weekday-parser']) });
    assert.deepEqual(run(s), []);
  });

  it('orders by dependency depth, then priority, then issue number', () => {
    const s = snapshot({
      issues: [issue(5, 'en/c'), issue(4, 'en/b'), issue(3, 'en/a'), issue(6, 'en/d')],
      pulls: [mergedPull(100, 'core/results'), mergedPull(101, 'en/base')],
      contractList: [
        contract('core/results', { scope: ['src/core/results.rs'] }),
        contract('en/base', { depends_on: ['core/results'] }),
        contract('en/a', { depends_on: ['en/base'], priority: 1 }), // depth 2
        contract('en/b', { priority: 9 }), // depth 0
        contract('en/c', { priority: 2 }), // depth 0
        contract('en/d', { priority: 2 }), // depth 0, higher issue number than c
      ],
    });
    const order = run(s).map((d) => `${d.type}:${d.task}`);
    assert.deepEqual(order, ['dispatched:en/c', 'dispatched:en/d', 'dispatched:en/b', 'wait:en/a']);
    assert.equal(find(run(s), 'wip_full').task, 'en/a');
  });
});

describe('planner: kill switch (fail closed)', () => {
  for (const value of [undefined, '', 'false', 'TRUE', 'true ', '1']) {
    it(`does not dispatch when FACTORY_ENABLED=${JSON.stringify(value)}`, () => {
      const ds = run(readyWorld(), { FACTORY_ENABLED: value });
      assert.ok(!ds.some((d) => d.type === 'dispatched' || d.type === 'repair_dispatched'));
      const k = find(ds, 'kill_switch');
      assert.equal(k.type, 'kill_switch');
      assert.deepEqual(k.source_ids, ['I_1', commitSha('en/weekday-parser')].sort());
    });
  }

  it('also stops repairs', () => {
    const ds = run(failingPrWorld('golden:x'), { FACTORY_ENABLED: 'false' });
    assert.deepEqual(reasons(ds), ['kill_switch']);
  });

  it('emits no kill_switch event when there is nothing to dispatch', () => {
    assert.deepEqual(run(snapshot(), { FACTORY_ENABLED: 'false' }), []);
  });
});

describe('planner: budgets', () => {
  it('alerts at 80% and still dispatches (budget_alert)', () => {
    const ds = run(readyWorld({ factory_aic_today: 8000 }));
    assert.equal(find(ds, 'budget_alert').type, 'budget_alert');
    assert.ok(ds.some((d) => d.type === 'dispatched'));
  });

  it('pauses dispatch at 100% (budget_pause)', () => {
    const ds = run(readyWorld({ factory_aic_today: 10000 }));
    const pause = ds.find((d) => d.type === 'budget_pause');
    assert.ok(pause);
    assert.equal(pause.effect, 'pause_dispatch');
    assert.ok(!ds.some((d) => d.type === 'dispatched'));
    assert.ok(ds.some((d) => d.type === 'wait' && d.reason === 'budget_pause'));
    assert.ok(!ds.some((d) => d.type === 'budget_alert'));
  });

  it('waits when spend is unknown (budget_unknown)', () => {
    const ds = run(readyWorld({ factory_aic_today: null }));
    assert.deepEqual(reasons(ds), ['budget_unknown']);
  });

  it('keys budget events by UTC day', () => {
    const d = find(run(readyWorld({ factory_aic_today: 9000 })), 'budget_alert');
    assert.deepEqual(d.source_ids, ['day:2026-10-16']);
  });
});

describe('planner: schedule', () => {
  it('waits when Actions is busy (actions_busy)', () => {
    assert.deepEqual(reasons(run(readyWorld({ busy_jobs: 15 }))), ['actions_busy']);
  });

  it('counts jobs of dispatches planned in the same run', () => {
    const s = snapshot({
      issues: [issue(1, 'en/a'), issue(2, 'en/b')],
      contractList: [contract('en/a'), contract('en/b')],
      busy_jobs: 13,
    });
    assert.deepEqual(reasons(run(s)), ['would_dispatch', 'actions_busy']);
  });

  it('waits when the busy job count is unknown (busy_jobs_unknown)', () => {
    assert.deepEqual(reasons(run(readyWorld({ busy_jobs: null }))), ['busy_jobs_unknown']);
  });

  it('respects the WIP limit (wip_full)', () => {
    const inflight = ['en/x', 'en/y', 'en/z'];
    const s = readyWorld({
      issues: [issue(1, 'en/weekday-parser'), ...inflight.map((t, i) => issue(10 + i, t, ['factory:picked']))],
      contractList: [
        contract('en/weekday-parser', { depends_on: ['core/results'] }),
        contract('core/results', { scope: ['src/core/results.rs'] }),
        ...inflight.map((t) => contract(t)),
      ],
      history: pickedRecently(inflight),
    });
    assert.deepEqual(reasons(run(s)), ['wip_full']);
  });

  it('serializes the core area (core_area_busy)', () => {
    const s = snapshot({
      issues: [issue(1, 'core/a'), issue(2, 'core/b', ['factory:picked'])],
      contractList: [
        contract('core/a', { scope: ['src/core/a.rs'], tier: 'human' }),
        contract('core/b', { scope: ['src/core/b.rs'], tier: 'human' }),
      ],
      history: pickedRecently(['core/b']),
    });
    assert.deepEqual(reasons(run(s)), ['core_area_busy']);
  });

  it('dispatches at most one core task per run', () => {
    const s = snapshot({
      issues: [issue(1, 'core/a'), issue(2, 'core/b')],
      contractList: [contract('core/a', { scope: ['src/core/a.rs'] }), contract('core/b', { scope: ['src/calculation/b.rs'] })],
    });
    assert.deepEqual(reasons(run(s)), ['would_dispatch', 'core_area_busy']);
  });

  it('holds one task per area lock (area_locked)', () => {
    const shared = 'src/locales/en/parsers/shared.rs';
    const s = snapshot({
      issues: [issue(1, 'en/a'), issue(2, 'en/b', ['factory:picked']), issue(3, 'en/c'), issue(4, 'en/d', ['factory:picked'])],
      contractList: [
        contract('en/a', { scope: [shared] }),
        contract('en/b', { scope: [shared, 'tests/locales/en/b.rs'] }),
        contract('en/c', { area: 'en-casual' }),
        contract('en/d', { area: 'en-casual' }),
      ],
      history: pickedRecently(['en/b', 'en/d']),
    });
    assert.deepEqual(reasons(run(s)), ['area_locked', 'area_locked']);
  });

  it('stops admitting human-tier work when the human queue is full (human_queue_full)', () => {
    const waiting = [20, 21, 22, 23, 24, 25].map((n) => issue(n, null, ['needs-human']));
    const s = snapshot({
      issues: [issue(1, 'en/human-task'), issue(2, 'en/auto-task'), ...waiting],
      contractList: [contract('en/human-task', { tier: 'human' }), contract('en/auto-task')],
    });
    const ds = run(s);
    assert.equal(find(ds, 'human_queue_full').task, 'en/human-task');
    assert.equal(find(ds, 'would_dispatch').task, 'en/auto-task');
  });

  it('allows human-tier work when the queue is exactly at the limit', () => {
    const waiting = [20, 21, 22, 23, 24].map((n) => issue(n, null, ['needs-human']));
    const s = snapshot({ issues: [issue(1, 'en/human-task'), ...waiting], contractList: [contract('en/human-task', { tier: 'human' })] });
    assert.deepEqual(reasons(run(s)), ['would_dispatch']);
  });

  it('counts open human-tier factory PRs and needs-human PRs in the human queue', () => {
    // 2 human-tier factory PRs (WIP 2 < 3) + 2 needs-human PRs + 2 needs-human issues = 6 > 5.
    const humanPrs = [30, 31].map((n) => pull(n, { task_id: `en/h${n}`, contract_sha: commitSha(`en/h${n}`) }));
    const labelled = [40, 41].map((n) => pull(n, { labels: ['needs-human'] }));
    const s = snapshot({
      issues: [issue(1, 'en/human-task'), issue(50, null, ['needs-human']), issue(51, null, ['needs-human'])],
      pulls: [...humanPrs, ...labelled],
      contractList: [contract('en/human-task', { tier: 'human' }), ...humanPrs.map((p) => contract(p.task_id!, { tier: 'human' }))],
    });
    assert.deepEqual(reasons(run(s)), ['human_queue_full']);
    // Draft PRs are not waiting for review: 5 items → admitted.
    const drafted = { ...s, pulls: [{ ...humanPrs[0]!, draft: true }, humanPrs[1]!, ...labelled] };
    assert.deepEqual(reasons(run(drafted)), ['would_dispatch']);
  });

  it('treats auto-strict paths as human tier while start_as is human', () => {
    const waiting = [20, 21, 22, 23, 24, 25].map((n) => issue(n, null, ['needs-human']));
    const s = snapshot({ issues: [issue(1, 'core/x'), ...waiting], contractList: [contract('core/x', { tier: 'auto', scope: ['src/core/x.rs'] })] });
    assert.deepEqual(reasons(run(s)), ['human_queue_full']);
  });
});

describe('planner: task time limit', () => {
  it('moves a task picked > 24 h ago to needs_human (task_timeout)', () => {
    const s = snapshot({
      issues: [issue(1, 'en/a', ['factory:picked'])],
      contractList: [contract('en/a')],
      history: { 'en/a': history({ picked_at: '2026-10-15T11:59:59Z' }) },
    });
    const d = find(run(s), 'task_timeout');
    assert.equal(d.type, 'needs_human');
    assert.equal(d.effect, 'label:needs-human');
    assert.deepEqual(d.source_ids, ['I_1', 'picked:2026-10-15T11:59:59Z']);
  });

  it('does not time out at exactly 24 h, nor merged tasks', () => {
    const s = snapshot({
      issues: [issue(1, 'en/a', ['factory:picked'])],
      contractList: [contract('en/a')],
      history: { 'en/a': history({ picked_at: '2026-10-15T12:00:00Z' }) },
    });
    assert.deepEqual(run(s), []);
    const merged = { ...s, pulls: [mergedPull(9, 'en/a')], history: { 'en/a': history({ picked_at: '2026-10-01T00:00:00Z' }) } };
    assert.ok(!run(merged).some((d) => d.reason === 'task_timeout'));
  });

  it('does not re-escalate a task already labelled needs-human', () => {
    const s = snapshot({
      issues: [issue(1, 'en/a', ['factory:picked', 'needs-human'])],
      contractList: [contract('en/a')],
      history: { 'en/a': history({ picked_at: '2026-10-14T00:00:00Z' }) },
    });
    assert.ok(!run(s).some((d) => d.reason === 'task_timeout'));
  });
});

describe('planner: failures', () => {
  it('dispatches a repair for a new failure (ci_failed)', () => {
    const d = find(run(failingPrWorld('golden:en/weekday#17')), 'ci_failed');
    assert.equal(d.type, 'repair_dispatched');
    assert.equal(d.effect, 'dispatch_workflow:repair');
    assert.equal(d.attempt, 2);
    assert.equal(d.run_id, 500);
    assert.equal(d.failure_signature, 'golden:en/weekday#17');
    assert.deepEqual(d.source_ids, ['500/attempts/1', 'PR_21']);
  });

  it('treats timed_out as a failure and ignores success/cancelled', () => {
    assert.ok(run(failingPrWorld('x', undefined, 'timed_out')).some((d) => d.reason === 'ci_failed'));
    // A green auto-tier PR goes to the merge stage instead (here it waits: its Contract-SHA is a prefix).
    assert.deepEqual(run(failingPrWorld('x', undefined, 'success')).map((d) => `${d.type}/${d.reason}`), ['wait/merge_not_ready']);
    assert.deepEqual(run(failingPrWorld('x', undefined, 'cancelled')), []);
  });

  it('sends the same signature twice to needs_human (repeated_signature)', () => {
    const d = find(run(failingPrWorld('sig-a', history({ picked_at: PICKED_RECENTLY, repairs: 1, failure_signatures: ['sig-a'] }))), 'repeated_signature');
    assert.equal(d.type, 'needs_human');
  });

  it('stops after max_repairs (max_repairs)', () => {
    const h = history({ picked_at: PICKED_RECENTLY, repairs: 2, failure_signatures: ['a', 'b'] });
    assert.equal(find(run(failingPrWorld('c', h)), 'max_repairs').type, 'needs_human');
    assert.ok(run(failingPrWorld('c', history({ picked_at: PICKED_RECENTLY, repairs: 1, failure_signatures: ['a'] }))).some((d) => d.reason === 'ci_failed'));
  });

  it('sends a failure without a signature to needs_human (missing_failure_signature)', () => {
    assert.equal(find(run(failingPrWorld(null)), 'missing_failure_signature').type, 'needs_human');
  });

  it('stops repairs when the per-task budget is spent (task_budget_exhausted)', () => {
    const d = find(run(failingPrWorld('z', history({ picked_at: PICKED_RECENTLY, aic_spent: 1000 }))), 'task_budget_exhausted');
    assert.equal(d.type, 'needs_human');
  });

  it('does not repeat a repair already dispatched for that run', () => {
    assert.deepEqual(run(failingPrWorld('z', history({ picked_at: PICKED_RECENTLY, repairs: 1, repaired_run_ids: [500], failure_signatures: ['y'] }))), []);
  });

  it('only looks at the run for the current head SHA', () => {
    const s = failingPrWorld('z');
    s.check_runs[1]!.head_sha = hex40('9');
    assert.deepEqual(run(s), []);
  });

  it('gates repairs on busy Actions (actions_busy)', () => {
    const s = failingPrWorld('z');
    s.busy_jobs = 20;
    assert.deepEqual(reasons(run(s)), ['actions_busy']);
  });
});

describe('planner: contract freshness', () => {
  const c = contract('en/weekday-parser');
  const world = (sha: string | null, contracts = [c]): Snapshot =>
    snapshot({ pulls: [pull(21, { task_id: 'en/weekday-parser', contract_sha: sha })], contractList: contracts });

  it('accepts the full SHA and a ≥7 char prefix', () => {
    assert.deepEqual(run(world(c.last_commit_sha)), []);
    assert.deepEqual(run(world(c.last_commit_sha.slice(0, 7))), []);
  });

  it('flags a different SHA as stale (contract_changed)', () => {
    const d = find(run(world('0000000')), 'contract_changed');
    assert.equal(d.type, 'stale_contract');
    assert.equal(d.contract_sha, c.last_commit_sha);
    assert.equal(d.effect, 'label:stale-contract');
  });

  it('does not accept the blob SHA in place of the commit SHA', () => {
    assert.equal(find(run(world(c.blob_sha)), 'contract_changed').type, 'stale_contract');
  });

  it('blocks a factory PR that does not declare Contract-SHA (missing_contract_sha)', () => {
    assert.equal(find(run(world(null)), 'missing_contract_sha').type, 'blocked');
  });

  it('flags a PR whose contract was withdrawn (contract_missing)', () => {
    assert.equal(find(run(world(c.last_commit_sha, [])), 'contract_missing').type, 'stale_contract');
  });

  it('blocks a PR whose contract is invalid (invalid_contract)', () => {
    assert.equal(find(run(world(c.last_commit_sha, [{ ...c, valid: false }])), 'invalid_contract').type, 'blocked');
  });

  it('ignores PRs without Factory-Task and PRs already labelled needs-human', () => {
    const s = snapshot({
      pulls: [pull(1), pull(2, { task_id: 'en/weekday-parser', contract_sha: '0000000', labels: ['needs-human'] })],
      contractList: [c],
    });
    assert.deepEqual(run(s), []);
  });
});

describe('review fix 5: newest run per head; gates vs ci', () => {
  const c = contract('en/weekday-parser');
  const pr = pull(21, { task_id: 'en/weekday-parser', contract_sha: c.last_commit_sha.slice(0, 7) });
  const MAIN_TIP = hex40('e');
  const world = (runs: ReturnType<typeof checkRun>[]): Snapshot =>
    snapshot({
      issues: [issue(1, 'en/weekday-parser', ['factory:picked'])],
      pulls: [pr],
      contractList: [c],
      check_runs: runs,
      history: pickedRecently(['en/weekday-parser']),
    });
  const ciFail = (id: number, over = {}) => checkRun(id, { head_sha: pr.head_sha, conclusion: 'failure', failure_signature: 'sig', ...over });
  const gates = (id: number, over = {}) =>
    checkRun(id, { workflow: 'gates', event: 'pull_request_target', head_sha: MAIN_TIP, candidate_sha: pr.head_sha, conclusion: 'failure', ...over });

  it('a newer ci run still in progress makes an older failure non-actionable', () => {
    assert.deepEqual(run(world([ciFail(500), checkRun(501, { head_sha: pr.head_sha, status: 'in_progress', conclusion: null })])), []);
  });

  it('a re-run attempt in progress also wins over the failed attempt', () => {
    assert.deepEqual(run(world([ciFail(500), checkRun(500, { head_sha: pr.head_sha, run_attempt: 2, status: 'queued', conclusion: null })])), []);
  });

  it('the newest completed run decides (a later success clears an older failure)', () => {
    assert.deepEqual(run(world([ciFail(500), checkRun(501, { head_sha: pr.head_sha, conclusion: 'success' })])), []);
    assert.deepEqual(reasons(run(world([gates(450, { conclusion: 'success' }), checkRun(499, { head_sha: pr.head_sha }), ciFail(500)]))), ['ci_failed']);
  });

  it('a failed gates run goes to needs_human (gates_failed) and is never repaired', () => {
    const ds = run(world([gates(600), ciFail(500)]));
    assert.deepEqual(ds.map((d) => `${d.type}/${d.reason}`), ['needs_human/gates_failed']);
    assert.equal(ds[0]!.effect, 'label:needs-human');
    assert.equal(ds[0]!.run_id, 600);
    assert.deepEqual(ds[0]!.source_ids, ['600/attempts/1', 'PR_21']);
  });

  it('ignores gates runs for another PR head and still-running gates (the repair waits: gates_pending); a newer pass wins', () => {
    assert.deepEqual(reasons(run(world([gates(600, { candidate_sha: hex40('9') }), ciFail(500)]))), ['gates_pending']);
    assert.deepEqual(reasons(run(world([gates(600, { status: 'in_progress', conclusion: null }), ciFail(500)]))), ['gates_pending']);
    assert.deepEqual(reasons(run(world([gates(600), gates(601, { conclusion: 'success' }), ciFail(500)]))), ['ci_failed']);
  });

  it('does not repair merge_group failures or count gates runs as ci', () => {
    assert.deepEqual(run(world([ciFail(500, { event: 'merge_group' })])), []);
    assert.deepEqual(run(world([checkRun(500, { workflow: 'gates', event: 'pull_request', head_sha: pr.head_sha, conclusion: 'failure', failure_signature: 's' })])), []);
  });
});

describe('review fix 6: one terminal decision per task per run', () => {
  it('a timed-out task with a new CI failure gets only needs_human/task_timeout', () => {
    const s = failingPrWorld('golden:en/weekday#17', history({ picked_at: '2026-10-15T10:00:00Z' }));
    const ds = run(s);
    assert.deepEqual(ds.map((d) => `${d.type}/${d.reason}`), ['needs_human/task_timeout']);
  });

  it('also suppresses failure escalations and contract decisions for a timed-out task', () => {
    const s = failingPrWorld(null, history({ picked_at: '2026-10-15T10:00:00Z' }));
    assert.deepEqual(reasons(run(s)), ['task_timeout']);
    s.pulls[0]!.contract_sha = '0000000';
    assert.deepEqual(reasons(run(s)), ['task_timeout']);
  });

  it('a task that is not timed out still gets its repair', () => {
    const s = failingPrWorld('golden:en/weekday#17', history({ picked_at: '2026-10-16T10:00:00Z' }));
    assert.deepEqual(reasons(run(s)), ['ci_failed']);
  });
});

describe('independent review (follow-up): fail closed', () => {
  it('a CI failure is not repaired while gates are missing, running, cancelled or skipped (gates_pending)', () => {
    const s = failingPrWorld('sig');
    const head = s.pulls[0]!.head_sha;
    const variants: Snapshot[] = [
      { ...s, check_runs: [s.check_runs[1]!] },
      { ...s, check_runs: [gatesRun(490, head, { status: 'in_progress', conclusion: null }), s.check_runs[1]!] },
      { ...s, check_runs: [gatesRun(490, head, { conclusion: 'cancelled' }), s.check_runs[1]!] },
      { ...s, check_runs: [gatesRun(490, head, { conclusion: 'skipped' }), s.check_runs[1]!] },
    ];
    for (const v of variants) {
      const ds = run(v);
      assert.deepEqual(ds.map((d) => `${d.type}/${d.reason}`), ['wait/gates_pending']);
      assert.equal(ds[0]!.effect, 'none');
    }
    // and it also holds back the needs_human escalations of the CI failure
    assert.deepEqual(reasons(run({ ...failingPrWorld(null), check_runs: [failingPrWorld(null).check_runs[1]!] })), ['gates_pending']);
  });

  it('a picked issue without a pick time in the window goes to needs_human (pick_time_unknown), once', () => {
    const s = snapshot({ issues: [issue(1, 'en/a', ['factory:picked'])], contractList: [contract('en/a')] });
    const ds = run(s);
    assert.deepEqual(ds.map((d) => `${d.type}/${d.reason}`), ['needs_human/pick_time_unknown']);
    assert.equal(ds[0]!.effect, 'label:needs-human');
    assert.deepEqual(ds[0]!.source_ids, ['I_1', 'picked:unknown']);
    // not when already escalated, merged, or the pick time is known
    assert.deepEqual(run(snapshot({ issues: [issue(1, 'en/a', ['factory:picked', 'needs-human'])], contractList: [contract('en/a')] })), []);
    assert.deepEqual(run({ ...s, pulls: [mergedPull(9, 'en/a')] }).filter((d) => d.reason === 'pick_time_unknown'), []);
    assert.deepEqual(run({ ...s, history: pickedRecently(['en/a']) }), []);
  });

  it('a task whose issue is labelled needs-human gets no repair, even when its PR is not labelled (review #20)', () => {
    // After pick_time_unknown, a human labels the issue only: repairs must not resume.
    const s = failingPrWorld('sig', history());
    s.issues[0]!.labels.push('needs-human');
    assert.deepEqual(run(s), []);
    // Same with a known pick time and a stale contract: no decision for a human-held task.
    const t = failingPrWorld('sig');
    t.issues[0]!.labels.push('needs-human');
    t.pulls[0]!.contract_sha = '0000000';
    assert.deepEqual(run(t), []);
  });

  it('a picked task with an open PR and no pick time gets only pick_time_unknown (one terminal decision)', () => {
    const s = failingPrWorld('sig', history());
    assert.deepEqual(reasons(run(s)), ['pick_time_unknown']);
  });

  it('PRs whose runs were not looked up wait (check_runs_incomplete) instead of acting on a stale run', () => {
    const s = failingPrWorld('sig');
    s.unchecked_heads = [s.pulls[0]!.head_sha];
    const ds = run(s);
    assert.deepEqual(ds.map((d) => `${d.type}/${d.reason}`), ['wait/check_runs_incomplete']);
    // a stale gates failure is not escalated either
    s.check_runs[0]!.conclusion = 'failure';
    assert.deepEqual(reasons(run(s)), ['check_runs_incomplete']);
  });

  it('unknown spend (null) never dispatches (budget_unknown)', () => {
    assert.deepEqual(reasons(run(readyWorld({ factory_aic_today: null }))), ['budget_unknown']);
    assert.deepEqual(reasons(run(failingPrWorld('sig'))), ['ci_failed']);
    assert.deepEqual(reasons(run({ ...failingPrWorld('sig'), factory_aic_today: null })), ['budget_unknown']);
  });
});

describe('review #22: a finished ci run without a trusted held-out seed goes to a human', () => {
  const ciRun = (s: Snapshot) => s.check_runs.find((r) => r.workflow === 'ci' && r.run_id === 500)!;
  it('passed or failed ci without a seed → needs_human/missing_heldout_seed (one terminal decision)', () => {
    for (const conclusion of ['success', 'failure']) {
      const s = failingPrWorld('sig', undefined, conclusion);
      ciRun(s).heldout_seed = null;
      const ds = run(s);
      assert.deepEqual(ds.map((d) => `${d.type}/${d.reason}`), ['needs_human/missing_heldout_seed'], conclusion);
      assert.equal(ds[0]!.effect, 'label:needs-human');
      assert.equal(ds[0]!.run_id, 500);
      assert.deepEqual(ds[0]!.source_ids, ['500/attempts/1', 'PR_21']);
    }
  });

  it('not for cancelled or startup failures (no reveal ran), and a failed gates run still wins', () => {
    for (const conclusion of ['cancelled', 'startup_failure']) {
      const s = failingPrWorld('sig', undefined, conclusion);
      ciRun(s).heldout_seed = null;
      assert.ok(!run(s).some((d) => d.reason === 'missing_heldout_seed'), conclusion);
    }
    const g = failingPrWorld('sig');
    ciRun(g).heldout_seed = null;
    g.check_runs.push(checkRun(600, { workflow: 'gates', event: 'pull_request_target', head_sha: hex40('e'), candidate_sha: g.pulls[0]!.head_sha, conclusion: 'failure' }));
    assert.deepEqual(reasons(run(g)), ['gates_failed']);
  });
});

describe('merge stage: auto-merge only green auto-tier agent PRs', () => {
  const MAIN_TIP = hex40('e');
  /** A green, eligible PR world for en/weekday-parser; `over` tweaks the pieces. */
  const world = (o: { contract?: Partial<ReturnType<typeof contract>>; pr?: Partial<ReturnType<typeof pull>>; issueLabels?: string[]; ci?: Record<string, unknown>; gates?: Record<string, unknown> | null } = {}): Snapshot => {
    const c = contract('en/weekday-parser', o.contract ?? {});
    const pr = pull(21, { task_id: 'en/weekday-parser', contract_sha: c.last_commit_sha, mergeable: 'MERGEABLE', in_merge_queue: false, ...(o.pr ?? {}) });
    return snapshot({
      issues: [issue(1, 'en/weekday-parser', o.issueLabels ?? ['factory:ready', 'factory:picked'])],
      pulls: [pr],
      contractList: [c],
      check_runs: [
        ...(o.gates === null ? [] : [checkRun(490, { workflow: 'gates', event: 'pull_request_target', head_sha: MAIN_TIP, candidate_sha: pr.head_sha, conclusion: 'success', ...(o.gates ?? {}) })]),
        checkRun(500, { head_sha: pr.head_sha, pull_requests: [21], conclusion: 'success', created_at: '2026-10-16T11:00:00Z', ...(o.ci ?? {}) }),
      ],
      history: { 'en/weekday-parser': history({ picked_at: '2026-10-16T10:00:00Z' }) },
    });
  };
  const decisions = (s: Snapshot, env: PlannerEnv = ON) => run(s, env).map((d) => `${d.type}/${d.reason}`);
  const blockerOf = (s: Snapshot) => run(s).find((d) => d.reason === 'merge_not_ready')?.source_ids.find((x) => x.startsWith('blocker:'));

  it('an eligible PR is queued: auto_merge/auto_merge_ready → enqueue_merge, keyed on the PR and its head', () => {
    const ds = run(world());
    assert.deepEqual(ds.map((d) => `${d.type}/${d.reason}`), ['auto_merge/auto_merge_ready']);
    assert.equal(ds[0]!.effect, 'enqueue_merge');
    assert.equal(ds[0]!.pr, 21);
    assert.deepEqual(ds[0]!.source_ids, ['PR_21', hex40('1')]);
  });

  it('never for human, auto-strict or core tiers (no merge decision at all)', () => {
    assert.deepEqual(decisions(world({ contract: { tier: 'human' } })), []);
    assert.deepEqual(decisions(world({ contract: { scope: ['src/core/results.rs'] } })), [], 'core / auto-strict (start_as human)');
    assert.deepEqual(decisions(world({ contract: { scope: ['src/common/parsers/x.rs'] } })), [], 'auto-strict path');
    assert.deepEqual(decisions(world({ contract: { scope: ['src/locales/en/parsers/a.rs', 'harness/x.js'] } })), [], 'any human path makes the task human');
  });

  it('waits (merge_not_ready) for each unmet condition, naming it', () => {
    const cases: [string, Parameters<typeof world>[0]][] = [
      ['blocker:contract_sha_not_exact', { pr: { contract_sha: commitSha('en/weekday-parser').slice(0, 7) } }],
      ['blocker:issue_not_picked', { issueLabels: ['factory:ready'] }],
      ['blocker:draft', { pr: { draft: true } }],
      ['blocker:not_agent_pr', { pr: { author: 'sabbasi3', author_is_bot: false } }],
      ['blocker:not_agent_pr', { pr: { author: 'other-bot[bot]', author_is_bot: true } }],
      ['blocker:not_mergeable', { pr: { mergeable: 'CONFLICTING' } }],
      ['blocker:not_mergeable', { pr: { mergeable: 'UNKNOWN' } }],
      ['blocker:not_mergeable', { pr: { mergeable: null } }],
    ];
    for (const [blocker, o] of cases) {
      const s = world(o);
      assert.deepEqual(decisions(s), ['wait/merge_not_ready'], blocker);
      assert.equal(blockerOf(s), blocker);
    }
    // A Contract-SHA that isn't even a prefix is stale (handled before the merge stage).
    assert.deepEqual(decisions(world({ pr: { contract_sha: '0000000' } })), ['stale_contract/contract_changed']);
  });

  it('nothing to merge unless both newest checks are success on the current head', () => {
    assert.deepEqual(decisions(world({ gates: null })), [], 'gates missing');
    assert.deepEqual(decisions(world({ gates: { status: 'in_progress', conclusion: null } })), [], 'gates running');
    assert.deepEqual(decisions(world({ gates: { conclusion: 'cancelled' } })), [], 'gates cancelled');
    assert.deepEqual(decisions(world({ gates: { candidate_sha: hex40('9') } })), [], 'gates for another head');
    assert.deepEqual(decisions(world({ ci: { status: 'in_progress', conclusion: null } })), [], 'ci running');
    assert.deepEqual(decisions(world({ ci: { head_sha: hex40('9') } })), [], 'ci for another head');
    assert.deepEqual(decisions(world({ ci: { heldout_seed: null } })), ['needs_human/missing_heldout_seed'], 'no trusted seed');
    const s = world();
    s.check_runs.push(checkRun(501, { head_sha: s.pulls[0]!.head_sha, conclusion: 'failure', failure_signature: 'step:x' }));
    assert.ok(!decisions(s).includes('auto_merge/auto_merge_ready'), 'a newer failing ci wins');
  });

  it('no merge decision for a task held by a human (needs-human on the issue or the PR)', () => {
    assert.deepEqual(decisions(world({ issueLabels: ['factory:picked', 'needs-human'] })), []);
    assert.deepEqual(decisions(world({ pr: { labels: ['needs-human'] } })), []);
  });

  describe('queue history: removals are tied to the controller\'s own enqueues (by head), not to run times', () => {
    const H = hex40('1');
    const OLD = hex40('7');
    const removal = (id: string, at: string, reason = 'manually removed') => ({ node_id: id, kind: 'dequeued' as const, created_at: at, actor: 'x', reason });
    const added = (id: string, at: string) => ({ node_id: id, kind: 'queued' as const, created_at: at, actor: 'x' });
    const withQueue = (events: MergeQueueEventSnap[], enqueued: { pr: number; head: string; at: string }[] = [], ci: Record<string, unknown> = {}) => {
      const s = world({ pr: { merge_queue_events: events as never }, ci });
      s.history['en/weekday-parser'] = { ...s.history['en/weekday-parser']!, enqueued };
      return s;
    };

    it('already in the queue: nothing', () => {
      assert.deepEqual(decisions(world({ pr: { in_merge_queue: true } })), []);
    });

    it('our enqueue of this head left the queue unmerged → merge_queue_rejected, even after a newer green run on the same head', () => {
      const s = withQueue([added('AMQ_1', '2026-10-16T11:10:00Z'), removal('RMQ_1', '2026-10-16T11:20:00Z', 'failed checks')], [{ pr: 21, head: H, at: '2026-10-16T11:10:00Z' }], { created_at: '2026-10-16T11:30:00Z' });
      const ds = run(s);
      assert.deepEqual(ds.map((d) => `${d.type}/${d.reason}`), ['needs_human/merge_queue_rejected']);
      assert.deepEqual([ds[0]!.effect, ds[0]!.source_ids], ['label:needs-human', ['PR_21', 'RMQ_1']]);
    });

    it('our enqueue of this head with no removal after it: already queued or merging, nothing to do', () => {
      assert.deepEqual(decisions(withQueue([added('AMQ_1', '2026-10-16T11:10:00Z')], [{ pr: 21, head: H, at: '2026-10-16T11:10:00Z' }])), []);
    });

    it('someone else queued it and it was removed → never auto re-queued (merge_queue_rejected), whatever the run times', () => {
      for (const ci of [{ created_at: '2026-10-16T11:00:00Z' }, { created_at: '2026-10-16T12:00:00Z' }]) {
        const s = withQueue([added('AMQ_9', '2026-10-16T11:10:00Z'), removal('RMQ_9', '2026-10-16T11:20:00Z')], [], ci);
        assert.deepEqual(decisions(s), ['needs_human/merge_queue_rejected']);
      }
    });

    it('our old head was queued and removed: the new head is still eligible (the removal is claimed by the old enqueue)', () => {
      const s = withQueue([added('AMQ_1', '2026-10-16T09:10:00Z'), removal('RMQ_1', '2026-10-16T11:20:00Z')], [{ pr: 21, head: OLD, at: '2026-10-16T09:10:00Z' }], { created_at: '2026-10-16T11:00:00Z' });
      assert.deepEqual(decisions(s), ['auto_merge/auto_merge_ready']);
    });

    it('a removal with reason "merged" is not a rejection', () => {
      assert.deepEqual(decisions(withQueue([removal('RMQ_1', '2026-10-16T11:20:00Z', 'merged')])), ['auto_merge/auto_merge_ready']);
    });

    it('the merge decision carries the planned head', () => {
      assert.equal(run(world())[0]!.head_sha, H);
    });
  });

  it('respects the kill switch: switch off → kill_switch aggregate, no merge decision', () => {
    assert.deepEqual(decisions(world(), { FACTORY_ENABLED: undefined }), ['kill_switch/kill_switch']);
    assert.deepEqual(decisions(world(), { FACTORY_ENABLED: 'TRUE' }), ['kill_switch/kill_switch']);
  });

  it('is not gated by spend or Actions load (merging spends no AI credits)', () => {
    const s = world();
    s.factory_aic_today = null;
    s.busy_jobs = null;
    assert.deepEqual(decisions(s), ['auto_merge/auto_merge_ready']);
  });

  it('does not wait for reviews: a Copilot review comment is a signal, not a gate', () => {
    const s = world({ pr: { reviews: [{ node_id: 'PRR_1', author: 'copilot-pull-request-reviewer', author_is_bot: true, state: 'COMMENTED', submitted_at: '2026-10-16T11:30:00Z' }] } });
    assert.deepEqual(decisions(s), ['auto_merge/auto_merge_ready']);
  });
});

describe('task done: a merged task leaves the pipeline', () => {
  const T = 'en/time-unit-ago-format-parser';
  const doneWorld = (over: SnapshotOverrides = {}) =>
    snapshot({ issues: [issue(45, T, ['factory:task', 'factory:ready', 'factory:picked'])], pulls: [mergedPull(54, T)], contractList: [contract(T)], ...over });

  it('an open issue whose task has a merged PR: task_done/task_merged → close_task (the #45 backfill)', () => {
    const ds = run(doneWorld());
    const d = find(ds, 'task_merged');
    assert.deepEqual([d.type, d.effect, d.task, d.issue, d.pr, d.source_ids], ['task_done', 'close_task', T, 45, 54, ['I_45', 'PR_54']]);
    assert.ok(!ds.some((x) => x.type === 'needs_human'), 'a picked issue whose task merged is not pick_time_unknown or a timeout');
    assert.ok(!ds.some((x) => x.type === 'dispatched'));
  });

  it('is planned whatever the issue labels (ready only, needs-human, none), with the first merged PR', () => {
    for (const labels of [['factory:ready'], ['needs-human'], []]) {
      const d = find(run(doneWorld({ issues: [issue(45, T, labels)], pulls: [mergedPull(60, T), mergedPull(54, T)] })), 'task_merged');
      assert.equal(d.pr, 54, labels.join(','));
    }
  });

  it('nothing for an open, closed-unmerged or other-task PR, or an issue without a valid marker', () => {
    for (const pulls of [[pull(54, { task_id: T })], [pull(54, { task_id: T, state: 'closed' })], [mergedPull(54, 'en/other')]]) {
      assert.ok(!reasons(run(doneWorld({ pulls }))).includes('task_merged'));
    }
    const noMarker = { ...issue(45, T), marker_status: 'invalid' as const, task_id: null };
    assert.ok(!reasons(run(doneWorld({ issues: [noMarker] }))).includes('task_merged'));
  });

  it('a leftover open PR for the merged task (here with failed gates) gets no decision and does not hold back the close', () => {
    const open = pull(57, { task_id: T, contract_sha: commitSha(T) });
    const ds = run(doneWorld({ pulls: [mergedPull(54, T), open], check_runs: [gatesRun(700, open.head_sha, { conclusion: 'failure' }), checkRun(701, { head_sha: open.head_sha, conclusion: 'failure' })] }));
    assert.deepEqual(reasons(ds), ['task_merged']);
  });

  it('the kill switch holds it (no close while FACTORY_ENABLED is off)', () => {
    const ds = run(doneWorld(), { FACTORY_ENABLED: undefined });
    assert.ok(!reasons(ds).includes('task_merged'));
    assert.ok(find(ds, 'kill_switch').source_ids.includes('PR_54'));
  });

  it('is deterministic: the same snapshot gives the same decision and source ids', () => {
    assert.deepEqual(run(doneWorld()), run(doneWorld()));
  });
});
