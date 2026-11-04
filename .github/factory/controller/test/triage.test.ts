import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decisionEvent } from '../executor.ts';
import { deriveState } from '../history.ts';
import { MAX_TRIAGES_PER_POLL, plan, triageCandidates } from '../planner.ts';
import type { AuditEvent, Decision, Policies } from '../types.ts';
import { contract, history, issue, NOW, snapshot, testPolicies } from './helpers.ts';

const base = await testPolicies();
const withTriage = (cap: number | null = 150): Policies => ({ ...base, budgets: { ...base.budgets, per_run: { ...base.budgets.per_run, needs_human_triage: cap } } });
const ON = { FACTORY_ENABLED: 'true' };
const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const TASK = 'en/weekday-parser';
const handedOff = (over: Record<string, unknown> = {}) =>
  snapshot({
    issues: [issue(10, TASK, ['factory:task', 'needs-human'])],
    contracts: { [`contracts/${TASK}.yaml`]: contract(TASK) },
    history: { [TASK]: history({ needs_human: { at: at(1), reason: 'repeated_signature', issue: 10, pr: 20, run_id: 99, failure_signature: 'step:golden' }, ...over }) },
  });
const triages = (ds: Decision[]) => ds.filter((d) => d.type === 'triage_dispatched');

describe('needs-human pre-triage (triage.md)', () => {
  it('a recorded hand-off whose issue still needs a person → one triage dispatch with its cause and evidence', () => {
    const [t, ...rest] = triages(plan(handedOff(), withTriage(), ON, NOW));
    assert.equal(rest.length, 0);
    assert.deepEqual(
      [t!.effect, t!.task, t!.issue, t!.pr, t!.run_id, t!.failure_signature, t!.cause],
      ['dispatch_workflow:triage', TASK, 10, 20, 99, 'step:golden', 'repeated_signature'],
    );
    assert.equal(decisionEvent(t!).fields.cause, 'repeated_signature');
  });

  it('off without the budget cap (absent or null): nothing dispatched', () => {
    assert.deepEqual(triages(plan(handedOff(), base, ON, NOW)), []);
    assert.deepEqual(triages(plan(handedOff(), withTriage(null), ON, NOW)), []);
  });

  it('behind the kill switch and the spend gates like every AI dispatch', () => {
    const off = plan(handedOff(), withTriage(), { FACTORY_ENABLED: undefined }, NOW);
    assert.deepEqual(triages(off), []);
    const paused = plan({ ...handedOff(), factory_aic_today: base.budgets.factory_per_day.max_aic }, withTriage(), ON, NOW);
    assert.deepEqual(triages(paused), []);
    assert.ok(paused.some((d) => d.type === 'wait' && d.reason === 'budget_pause' && d.task === TASK));
  });

  it('once per hand-off: a triage since then, a person who took the label off, or an old hand-off → nothing', () => {
    assert.deepEqual(triages(plan(handedOff({ triages: [{ at: at(0.5) }] }), withTriage(), ON, NOW)), []);
    const relabelled = { ...handedOff(), issues: [issue(10, TASK, ['factory:task', 'factory:ready'])] };
    assert.deepEqual(triages(plan(relabelled, withTriage(), ON, NOW)), []);
    const old = handedOff({ needs_human: { at: at(30), reason: 'max_repairs', issue: 10, pr: null, run_id: null, failure_signature: null } });
    assert.deepEqual(triages(plan(old, withTriage(), ON, NOW)), []);
    // A new hand-off after an earlier triage is triaged again.
    assert.equal(triages(plan(handedOff({ triages: [{ at: at(5) }] }), withTriage(), ON, NOW)).length, 1);
  });

  it("this poll's needs_human decisions are triaged too, at most MAX_TRIAGES_PER_POLL, oldest first", () => {
    const s = snapshot({ issues: [1, 2, 3].map((n) => issue(n, `en/t${n}`, ['factory:task', 'picked'])) });
    const nh = (n: number): Decision => ({ type: 'needs_human', reason: 'ci_not_repairable', effect: 'label:needs-human', dry_run: true, task: `en/t${n}`, issue: null, pr: 30 + n, attempt: null, contract_sha: null, run_id: 7, failure_signature: null, source_ids: [] });
    const ds = triageCandidates(s, withTriage(), [nh(1), nh(2), nh(3)], NOW);
    assert.equal(ds.length, MAX_TRIAGES_PER_POLL);
    assert.deepEqual(ds.map((d) => [d.task, d.issue, d.pr, d.cause]), [['en/t1', 1, 31, 'ci_not_repairable'], ['en/t2', 2, 32, 'ci_not_repairable']]);
  });

  it('history: the latest live needs_human and triage_dispatched events (dry-run ones never count)', () => {
    const ev = (type: string, ts: string, payload: Record<string, unknown>, dry = false): AuditEvent =>
      ({ version: 1, id: 'x', type, timestamp: ts, parents: [], payload: { dedupe_key: 'k', factory_version: 'v', dry_run: dry, ...payload }, sha: 's' }) as unknown as AuditEvent;
    const h = deriveState(
      [
        ev('needs_human', '2026-10-16T08:00:00Z', { task: TASK, reason: 'gates_failed', issue: 10 }),
        ev('needs_human', '2026-10-16T09:00:00Z', { task: TASK, reason: 'max_repairs', issue: 10, pr: 20, run_id: 5, failure_signature: 'step:x' }),
        ev('triage_dispatched', '2026-10-16T09:01:00Z', { task: TASK, reason: 'triage_needed' }),
        ev('triage_dispatched', '2026-10-16T09:02:00Z', { task: TASK, reason: 'triage_needed' }, true),
      ],
      NOW,
    ).history[TASK]!;
    assert.deepEqual(h.needs_human, { at: '2026-10-16T09:00:00Z', reason: 'max_repairs', issue: 10, pr: 20, run_id: 5, failure_signature: 'step:x' });
    assert.deepEqual(h.triages, [{ at: '2026-10-16T09:01:00Z' }]);
  });
});
