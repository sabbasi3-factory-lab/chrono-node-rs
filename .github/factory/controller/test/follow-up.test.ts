import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import type { DispatchStatus } from '../dispatch-state.ts';
import { FakeGitHub } from '../fake.ts';
import { FOLLOW_UP_MAX_CHAIN, followUp, followUpWanted, parseChain } from '../follow-up.ts';
import { assertAllowedRequest } from '../github.ts';
import { REPO } from './helpers.ts';

const st = (state: DispatchStatus['state'], reason: DispatchStatus['reason'] = 'none'): DispatchStatus =>
  ({ state, reason, ready: 0, in_flight: state === 'running' ? 1 : 0, spend_known: true, unreadable_runs: 0, since: '2026-10-16T12:00:00Z', since_source: 'transition' });
const RUNS = new RegExp(`^/repos/${REPO}/actions/workflows/controller\\.yml/runs$`);
const DISPATCH = `/repos/${REPO}/actions/workflows/controller.yml/dispatches`;

/** Runs by status filter (`?status=`); null: every list request fails. */
function world(runs: { id: number; status: string }[] | null, pages: Record<string, { id: number; status: string }[][]> = {}): FakeGitHub {
  const gh = new FakeGitHub(REPO);
  gh.addRoute('GET', RUNS, (path) => {
    assert.match(path, /event=workflow_dispatch/);
    if (runs === null) return { status: 500, data: null };
    const status = /[?&]status=([a-z_]+)/.exec(path)?.[1] ?? '';
    const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? '1');
    const paged = pages[status];
    if (paged) {
      const next = page < paged.length ? `/repos/${REPO}/actions/workflows/controller.yml/runs?event=workflow_dispatch&status=${status}&per_page=100&page=${page + 1}` : null;
      return { data: { workflow_runs: paged[page - 1] }, next };
    }
    return { data: { workflow_runs: runs.filter((r) => r.status === status) } };
  });
  gh.addRoute('POST', new RegExp(`^${DISPATCH}$`), () => ({ status: 204, data: null }));
  return gh;
}

describe('follow-up poll (cron runs every 2–8 h here)', () => {
  it('chain input: empty is 0; 1..24 as given; anything else is invalid (null)', () => {
    assert.equal(parseChain(undefined), 0);
    assert.equal(parseChain(''), 0);
    assert.equal(parseChain('1'), 1);
    assert.equal(parseChain(String(FOLLOW_UP_MAX_CHAIN)), FOLLOW_UP_MAX_CHAIN);
    for (const bad of ['0', '25', '-1', '01', '1.5', 'x', ' 1', '999']) assert.equal(parseChain(bad), null, bad);
  });

  it('wanted only live, below the cap, and while running, waiting or paused for a reason that can clear', () => {
    assert.equal(followUpWanted(st('running'), true, 0), 'wanted');
    assert.equal(followUpWanted(st('waiting', 'limits'), true, 3), 'wanted');
    for (const r of ['budget_unknown', 'budget_pause', 'busy_jobs_unknown', 'actions_busy'] as const) assert.equal(followUpWanted(st('paused', r), true, 0), 'wanted', r);
    assert.equal(followUpWanted(st('paused', 'kill_switch'), true, 0), 'kill_switch');
    assert.equal(followUpWanted(st('idle'), true, 0), 'idle');
    assert.equal(followUpWanted(st('running'), false, 0), 'dry_run', 'dry-run (FACTORY_ENABLED not exactly true) never dispatches');
    assert.equal(followUpWanted(st('running'), true, FOLLOW_UP_MAX_CHAIN), 'chain_cap');
    assert.equal(followUpWanted(st('running'), true, null), 'invalid_chain');
  });

  it('dispatches the next position on main when none is pending (its own run doesn\'t count)', async () => {
    const gh = world([{ id: 7, status: 'in_progress' }, { id: 6, status: 'completed' }]);
    const lines: string[] = [];
    assert.equal(await followUp(gh, REPO, 7, st('running'), true, 2, (l) => lines.push(l)), 'dispatched');
    const post = gh.calls.filter((c) => c.method === 'POST');
    assert.deepEqual(post, [{ method: 'POST', path: DISPATCH, body: { ref: 'main', inputs: { chain: '3' } } }]);
    assert.match(lines.join('\n'), /dispatched \(chain 3 of 24/);
  });

  it('one chain at a time: another queued or running dispatched run means no new one', async () => {
    for (const status of ['queued', 'in_progress', 'waiting', 'pending', 'requested']) {
      const gh = world([{ id: 8, status }, { id: 7, status: 'in_progress' }]);
      assert.equal(await followUp(gh, REPO, 7, st('running'), true, 0, () => {}), 'pending', status);
      assert.equal(gh.calls.filter((c) => c.method === 'POST').length, 0);
    }
  });

  it('looks past the first page of a status (a re-run older run can be pending further back)', async () => {
    const gh = world([], { in_progress: [[{ id: 7, status: 'in_progress' }], [{ id: 3, status: 'in_progress' }]] });
    assert.equal(await followUp(gh, REPO, 7, st('running'), true, 0, () => {}), 'pending');
    assert.equal(gh.calls.filter((c) => c.method === 'POST').length, 0);
  });

  it('fails closed: an unreadable run list means no dispatch; a failed dispatch is logged, not thrown', async () => {
    const down = world(null);
    assert.equal(await followUp(down, REPO, 7, st('running'), true, 0, () => {}), 'unknown');
    assert.equal(down.calls.filter((c) => c.method === 'POST').length, 0);
    const gh = new FakeGitHub(REPO);
    gh.addRoute('GET', RUNS, () => ({ data: { workflow_runs: [] } }));
    gh.addRoute('POST', new RegExp(`^${DISPATCH}$`), () => ({ status: 403, data: null }));
    const bad = new FakeGitHub(REPO);
    bad.addRoute('GET', RUNS, () => ({ data: { nope: [] } }));
    assert.equal(await followUp(bad, REPO, 7, st('running'), true, 0, () => {}), 'unknown', 'a malformed page');
    const lines: string[] = [];
    assert.equal(await followUp(gh, REPO, 7, st('running'), true, 0, (l) => lines.push(l)), 'failed');
    assert.match(lines.join('\n'), /WARNING: follow-up poll not dispatched/);
  });

  it('not wanted → no API call at all', async () => {
    const gh = world([]);
    for (const [s, live, chain] of [[st('idle'), true, 0], [st('running'), false, 0], [st('running'), true, 24], [st('paused', 'kill_switch'), true, 0]] as const) {
      await followUp(gh, REPO, 7, s, live, chain, () => {});
    }
    assert.equal(gh.calls.length, 0);
  });

  it('the live allowlist admits only controller.yml on main with chain 1..24', () => {
    const ok = (body: unknown, mode: 'live' | 'dry-run' = 'live') => {
      try {
        assertAllowedRequest(REPO, 'POST', DISPATCH, body, mode);
        return true;
      } catch {
        return false;
      }
    };
    for (const c of ['1', '12', '24']) assert.equal(ok({ ref: 'main', inputs: { chain: c } }), true, c);
    assert.equal(ok({ ref: 'main', inputs: { chain: '1' } }, 'dry-run'), false);
    for (const bad of [{ ref: 'main', inputs: { chain: '0' } }, { ref: 'main', inputs: { chain: '25' } }, { ref: 'main', inputs: { chain: 1 } }, { ref: 'dev', inputs: { chain: '1' } }, { ref: 'main', inputs: { chain: '1', x: 'y' } }, { ref: 'main', inputs: {} }, { ref: 'main' }]) {
      assert.equal(ok(bad), false, JSON.stringify(bad));
    }
  });

  it('the workflow: the wait is its own job with no permissions, outside the concurrency group; chain reaches the controller', async () => {
    const yml = await readFile(new URL('../../../workflows/controller.yml', import.meta.url), 'utf8');
    const wait = yml.slice(yml.indexOf('\n  wait:'), yml.indexOf('\n  controller:'));
    assert.match(wait, /permissions: \{\}/);
    assert.match(wait, /sleep 600/);
    assert.doesNotMatch(wait, /concurrency|checkout|secrets|token/i);
    assert.match(wait, /github\.event_name == 'workflow_dispatch' && inputs\.chain != ''/);
    assert.doesNotMatch(yml.slice(0, yml.indexOf('\njobs:')), /\nconcurrency:/, 'no workflow-level concurrency (it would hold the wait in the group)');
    const ctrl = yml.slice(yml.indexOf('\n  controller:'));
    assert.match(ctrl, /needs: wait/);
    assert.match(ctrl, /group: factory-controller\n\s+cancel-in-progress: false/);
    assert.match(ctrl, /FACTORY_CHAIN: \$\{\{ inputs\.chain \}\}/);
  });
});
