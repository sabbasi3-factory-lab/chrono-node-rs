import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dispatchStatus, REFRESH_MS, shouldRecord, type PrevState } from '../dispatch-state.ts';
import { plan } from '../planner.ts';
import type { Decision } from '../types.ts';
import { contract, history, issue, NOW, pull, snapshot, testPolicies } from './helpers.ts';

const ON = { FACTORY_ENABLED: 'true' };
const wait = (reason: string): Decision => ({ type: 'wait', reason } as unknown as Decision);
const T = '2026-10-16T12:00:00Z';
const prevOf = (timestamp: string, payload: Record<string, unknown>): PrevState => ({ timestamp, payload });

describe('dispatch state (the control room banner)', () => {
  const ready = snapshot({ issues: [issue(1, 'en/a', ['factory:task', 'factory:ready'])], contractList: [contract('en/a')] });

  it('a global gate holding back ready work → paused with that reason (and the unreadable count when spend is unknown)', () => {
    for (const r of ['budget_unknown', 'budget_pause', 'busy_jobs_unknown', 'actions_busy']) {
      const st = dispatchStatus([wait(r)], ready, ON, r !== 'budget_unknown', 2, null, NOW);
      assert.equal(st.state, 'paused', r);
      assert.equal(st.reason, r);
      assert.equal(st.ready, 1);
      assert.equal(st.unreadable_runs, r === 'budget_unknown' ? 2 : 0);
    }
  });

  it('the kill switch off → paused (kill_switch), even with nothing to do', () => {
    assert.deepEqual(dispatchStatus([], snapshot(), { FACTORY_ENABLED: undefined }, true, 0, null, NOW),
      { state: 'paused', reason: 'kill_switch', ready: 0, in_flight: 0, spend_known: true, unreadable_runs: 0, since: T, since_source: 'first_record' });
  });

  it('in flight counts what the planner counts: an open factory PR (issue closed) or a recorded pick → running', () => {
    const prOnly = snapshot({ pulls: [pull(9, { task_id: 'en/a' })] });
    assert.deepEqual([dispatchStatus([], prOnly, ON, true, 0, null, NOW).state, dispatchStatus([], prOnly, ON, true, 0, null, NOW).in_flight], ['running', 1]);
    const pickedAt = snapshot({ issues: [issue(1, 'en/a', ['factory:task'])], history: { 'en/a': history({ picked_at: '2026-10-16T10:00:00Z' }) } });
    assert.equal(dispatchStatus([], pickedAt, ON, true, 0, null, NOW).in_flight, 1);
    const picked = snapshot({ issues: [issue(1, 'en/a', ['factory:task', 'factory:ready', 'factory:picked'])], contractList: [contract('en/a')] });
    assert.equal(dispatchStatus([], picked, ON, true, 0, null, NOW).state, 'running');
    assert.equal(dispatchStatus([{ type: 'dispatched' } as unknown as Decision], ready, ON, true, 0, null, NOW).state, 'running');
  });

  it('waiting only on an explicit wait: a capacity limit → limits, unmerged dependencies → deps; else idle', () => {
    for (const r of ['wip_full', 'human_queue_full', 'core_area_busy', 'area_locked']) {
      assert.deepEqual([dispatchStatus([wait(r)], ready, ON, true, 0, null, NOW).state, dispatchStatus([wait(r)], ready, ON, true, 0, null, NOW).reason], ['waiting', 'limits'], r);
    }
    assert.equal(dispatchStatus([wait('deps_not_merged')], ready, ON, true, 0, null, NOW).reason, 'deps');
    // A ready issue with no wait decision (blocked, needs-human, already merged): not "held by limits".
    assert.deepEqual(dispatchStatus([], ready, ON, true, 0, null, NOW), { state: 'idle', reason: 'none', ready: 1, in_flight: 0, spend_known: true, unreadable_runs: 0, since: T, since_source: 'first_record' });
    assert.deepEqual(dispatchStatus([], snapshot(), ON, false, 1, null, NOW), { state: 'idle', reason: 'none', ready: 0, in_flight: 0, spend_known: false, unreadable_runs: 1, since: T, since_source: 'first_record' });
  });

  it('from the real planner: spend unknown → paused/budget_unknown; unmet dependency → waiting/deps', async () => {
    const p = await testPolicies();
    const s = { ...ready, factory_aic_today: null };
    assert.equal(dispatchStatus(plan(s, p, ON, NOW), s, ON, false, 2, null, NOW).reason, 'budget_unknown');
    const dep = snapshot({ issues: [issue(1, 'en/b', ['factory:task', 'factory:ready'])], contractList: [contract('en/b', { depends_on: ['en/a'] })] });
    assert.equal(dispatchStatus(plan(dep, p, ON, NOW), dep, ON, true, 0, null, NOW).reason, 'deps');
  });

  it('"since" carries over while the state and reason hold (from the payload, else the event time), and resets on a change', () => {
    const prev = prevOf('2026-10-16T09:00:00Z', { state: 'paused', reason: 'budget_unknown', since: '2026-10-14T17:43:00Z' });
    assert.equal(dispatchStatus([wait('budget_unknown')], ready, ON, false, 3, prev, NOW).since, '2026-10-14T17:43:00Z');
    const old = prevOf('2026-10-16T09:00:00Z', { state: 'paused', reason: 'budget_unknown' });
    assert.equal(dispatchStatus([wait('budget_unknown')], ready, ON, false, 3, old, NOW).since, '2026-10-16T09:00:00Z');
    assert.equal(dispatchStatus([wait('actions_busy')], ready, ON, true, 0, prev, NOW).since, T);
  });

  it('a spend pause backfills "since" from when the first unreadable run ended; else first_record or transition', () => {
    const w = [wait('budget_unknown')];
    const first = dispatchStatus(w, ready, ON, false, 2, null, NOW, '2026-10-16T08:43:10Z');
    assert.deepEqual([first.since, first.since_source], ['2026-10-16T08:43:10Z', 'evidence']);
    const none = dispatchStatus(w, ready, ON, false, 2, null, NOW, null);
    assert.deepEqual([none.since, none.since_source], [T, 'first_record']);
    assert.equal(dispatchStatus(w, ready, ON, false, 2, null, NOW, '2026-10-16T13:00:00Z').since_source, 'first_record', 'evidence from the future is ignored');
    const afterRun = prevOf('2026-10-16T10:00:00Z', { state: 'running', reason: 'none' });
    const t = dispatchStatus(w, ready, ON, false, 2, afterRun, NOW, null);
    assert.deepEqual([t.since, t.since_source], [T, 'transition']);
    // A legacy record (no since_source) of the same pause is upgraded to the evidence, and recorded.
    const legacy = prevOf('2026-10-16T10:10:00Z', { state: 'paused', reason: 'budget_unknown', spend_known: false, unreadable_runs: 2, ready: 1, in_flight: 0, since: '2026-10-16T10:10:00Z' });
    const up = dispatchStatus(w, ready, ON, false, 2, legacy, NOW, '2026-10-16T08:43:10Z');
    assert.deepEqual([up.since, up.since_source], ['2026-10-16T08:43:10Z', 'evidence']);
    assert.equal(shouldRecord(legacy, up, NOW), true);
    // Once from evidence, it holds (a later unreadable run doesn't move it).
    const held = dispatchStatus(w, ready, ON, false, 3, prevOf('2026-10-16T11:00:00Z', { ...up }), NOW, '2026-10-16T09:00:00Z');
    assert.deepEqual([held.since, held.since_source], ['2026-10-16T08:43:10Z', 'evidence']);
    assert.equal(shouldRecord(prevOf('2026-10-16T11:00:00Z', { ...held, unreadable_runs: 3 }), held, NOW), false);
    // Evidence applies only to a spend pause.
    assert.equal(dispatchStatus([wait('actions_busy')], ready, ON, false, 2, null, NOW, '2026-10-16T08:43:10Z').since_source, 'first_record');
  });

  it('recorded on a change in what the banner shows, or once the newest record is a day old', () => {
    const st = dispatchStatus([wait('budget_unknown')], ready, ON, false, 2, null, NOW);
    const recent = (over: Record<string, unknown> = {}): PrevState => prevOf('2026-10-16T11:00:00Z', { ...st, ...over });
    assert.equal(shouldRecord(null, st, NOW), true);
    assert.equal(shouldRecord(recent(), st, NOW), false);
    assert.equal(shouldRecord(recent({ ready: 5, in_flight: 3 }), st, NOW), false, 'counts of ready and in-flight work alone are not a transition');
    assert.equal(shouldRecord(recent({ unreadable_runs: 1 }), st, NOW), true);
    assert.equal(shouldRecord(recent({ state: 'running', reason: 'none' }), st, NOW), true);
    assert.equal(shouldRecord(prevOf(new Date(NOW.getTime() - REFRESH_MS + 1000).toISOString().replace('.000Z', 'Z'), { ...st }), st, NOW), false);
    assert.equal(shouldRecord(prevOf(new Date(NOW.getTime() - REFRESH_MS).toISOString().replace('.000Z', 'Z'), { ...st }), st, NOW), true, 'a day old: re-record so it stays in the window');
  });
});
