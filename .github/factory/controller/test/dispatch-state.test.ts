import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dispatchStatus, stateChanged } from '../dispatch-state.ts';
import { plan } from '../planner.ts';
import type { Decision } from '../types.ts';
import { contract, issue, NOW, snapshot, testPolicies } from './helpers.ts';

const ON = { FACTORY_ENABLED: 'true' };
const wait = (reason: string): Decision => ({ type: 'wait', reason } as unknown as Decision);

describe('dispatch state (the control room banner)', () => {
  const ready = snapshot({ issues: [issue(1, 'en/a', ['factory:task', 'factory:ready'])], contractList: [contract('en/a')] });

  it('a global gate holding back ready work → paused with that reason (and the unreadable count when spend is unknown)', () => {
    for (const r of ['budget_unknown', 'budget_pause', 'busy_jobs_unknown', 'actions_busy']) {
      const st = dispatchStatus([wait(r)], ready, ON, r !== 'budget_unknown', 2);
      assert.equal(st.state, 'paused', r);
      assert.equal(st.reason, r);
      assert.equal(st.ready, 1);
      assert.equal(st.unreadable_runs, r === 'budget_unknown' ? 2 : 0);
    }
  });

  it('the kill switch off → paused (kill_switch), even with nothing to do', () => {
    assert.deepEqual(dispatchStatus([], snapshot(), { FACTORY_ENABLED: undefined }, true, 0), { state: 'paused', reason: 'kill_switch', ready: 0, in_flight: 0, spend_known: true, unreadable_runs: 0 });
  });

  it('agents in flight or a dispatch now → running; ready work held by limits → waiting; nothing → idle (spend flagged)', () => {
    const picked = snapshot({ issues: [issue(1, 'en/a', ['factory:task', 'factory:ready', 'factory:picked'])], contractList: [contract('en/a')] });
    assert.equal(dispatchStatus([], picked, ON, true, 0).state, 'running');
    assert.equal(dispatchStatus([{ type: 'dispatched' } as unknown as Decision], ready, ON, true, 0).state, 'running');
    assert.deepEqual(dispatchStatus([], ready, ON, true, 0), { state: 'waiting', reason: 'limits', ready: 1, in_flight: 0, spend_known: true, unreadable_runs: 0 });
    assert.deepEqual(dispatchStatus([], snapshot(), ON, false, 1), { state: 'idle', reason: 'none', ready: 0, in_flight: 0, spend_known: false, unreadable_runs: 1 });
  });

  it('from the real planner: a ready task with spend unknown → paused/budget_unknown', async () => {
    const p = await testPolicies();
    const s = { ...ready, factory_aic_today: null };
    assert.equal(dispatchStatus(plan(s, p, ON, NOW), s, ON, false, 2).reason, 'budget_unknown');
  });

  it('a new event only when what the banner shows changes', () => {
    const st = dispatchStatus([wait('budget_unknown')], ready, ON, false, 2);
    assert.equal(stateChanged(null, st), true);
    assert.equal(stateChanged({ ...st }, st), false);
    assert.equal(stateChanged({ ...st, ready: 5, in_flight: 3 }, st), false, 'counts of ready and in-flight work alone are not a transition');
    assert.equal(stateChanged({ ...st, unreadable_runs: 1 }, st), true);
    assert.equal(stateChanged({ ...st, state: 'running', reason: 'none' }, st), true);
  });
});
