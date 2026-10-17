import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dedupeKey } from '../audit.ts';
import { deriveState } from '../history.ts';
import { observe } from '../observe.ts';
import { buildEvent } from '../audit.ts';
import { checkRun, hex40, NOW, pull, snapshot } from './helpers.ts';

describe('observe', () => {
  const s = snapshot({
    pulls: [
      pull(1, {
        created_at: '2026-10-16T09:00:00Z',
        state: 'merged',
        merged_at: '2026-10-16T11:00:00Z',
        merge_commit_sha: hex40('e'),
        task_id: 'en/a',
        author: 'sabbasi3',
        author_is_bot: false,
        reviews: [
          { node_id: 'PRR_1', author: 'sabbasi3', author_is_bot: false, state: 'APPROVED', submitted_at: '2026-10-16T10:00:00Z' },
          { node_id: 'PRR_2', author: 'helper[bot]', author_is_bot: true, state: 'APPROVED', submitted_at: '2026-10-16T10:01:00Z' },
          { node_id: 'PRR_3', author: 'sabbasi3', author_is_bot: false, state: 'PENDING', submitted_at: null },
        ],
        merge_queue_events: [
          { node_id: 'MQ_1', kind: 'queued', created_at: '2026-10-16T10:30:00Z', actor: 'sabbasi3' },
          { node_id: 'MQ_2', kind: 'dequeued', created_at: '2026-10-16T11:00:00Z', actor: null },
        ],
      }),
      pull(2, { created_at: '2026-10-14T09:00:00Z' }), // outside the window
    ],
    check_runs: [
      checkRun(77, { run_attempt: 2, pull_requests: [3, 1], heldout_seed: '123', failure_signature: 'golden:en/a#1', conclusion: 'failure' }),
      checkRun(78, { status: 'in_progress', conclusion: null }),
      checkRun(79, { updated_at: '2026-10-15T11:59:59Z' }),
    ],
  });

  it('emits each fact type once, in time order', () => {
    const ev = observe(s, NOW);
    assert.deepEqual(
      ev.map((e) => e.type),
      ['pr_opened', 'human_action', 'queued', 'dequeued', 'merged', 'check_result'],
    );
  });

  it('builds payloads from IDs, SHAs, numbers, logins and enums only', () => {
    const ev = observe(s, NOW);
    const cr = ev.find((e) => e.type === 'check_result')!;
    assert.deepEqual(cr.fields, {
      workflow: 'ci',
      run_id: 77,
      run_attempt: 2,
      event: 'pull_request',
      head_sha: hex40('0'),
      prs: [1, 3],
      conclusion: 'failure',
      completed_at: '2026-10-16T11:10:00Z',
      heldout_seed: '123',
      failure_signature: 'golden:en/a#1',
    });
    assert.deepEqual(cr.source_ids, ['77/attempts/2']);
    const ha = ev.find((e) => e.type === 'human_action')!;
    assert.deepEqual(ha.fields, { action: 'review', pr: 1, reviewer: 'sabbasi3', state: 'APPROVED', submitted_at: '2026-10-16T10:00:00Z' });
    assert.deepEqual(ev.find((e) => e.type === 'merged')!.fields, { pr: 1, merge_commit_sha: hex40('e'), merged_at: '2026-10-16T11:00:00Z', task: 'en/a' });
  });

  it('omits heldout_seed when CI did not print one', () => {
    const ev = observe(snapshot({ check_runs: [checkRun(5, { heldout_seed: null })] }), NOW);
    assert.equal('heldout_seed' in ev[0]!.fields, false);
  });

  it('gives a fact the same dedupe key on every run', () => {
    const a = observe(s, NOW).map((e) => dedupeKey(e.type, e.source_ids));
    const b = observe(structuredClone(s), new Date('2026-10-16T12:05:00Z')).map((e) => dedupeKey(e.type, e.source_ids));
    assert.deepEqual(a, b);
    assert.equal(new Set(a).size, a.length);
  });

  it('ignores facts in the future (clock skew)', () => {
    const early = new Date('2026-10-16T10:15:00Z');
    assert.deepEqual(observe(s, early).map((e) => e.type), ['check_result', 'pr_opened', 'human_action']);
  });
});

describe('history (from audit events)', () => {
  const ev = (type: string, ts: string, p: Record<string, number | string | boolean>) =>
    buildEvent({ type, timestamp: ts, parents: [], payload: { ...p, dedupe_key: dedupeKey(type, [ts]), factory_version: 'x', dry_run: p.dry_run ?? false } });

  it('ignores dry-run events entirely', () => {
    const d = deriveState([ev('dispatched', '2026-10-16T01:00:00Z', { task: 'en/a', dry_run: true }), ev('run_finished', '2026-10-16T02:00:00Z', { task: 'en/a', aic: 50, dry_run: true })], NOW);
    assert.deepEqual(d, { history: {}, factory_aic_today: null });
  });

  it('spend is unknown (null) without a spend_snapshot for today, even with run_finished events (fail closed)', () => {
    assert.equal(deriveState([], NOW).factory_aic_today, null);
    assert.equal(deriveState([ev('run_finished', '2026-10-16T02:00:00Z', { task: 'en/a', aic: 40 })], NOW).factory_aic_today, null);
    // yesterday's snapshot, a snapshot for another day, a bad value, and a dry-run snapshot don't count
    const notToday = [
      ev('spend_snapshot', '2026-10-15T23:00:00Z', { day: '2026-10-15', aic_today: 10 }),
      ev('spend_snapshot', '2026-10-16T01:00:00Z', { day: '2026-10-15', aic_today: 10 }),
      ev('spend_snapshot', '2026-10-16T01:30:00Z', { day: '2026-10-16', aic_today: -1 }),
      ev('spend_snapshot', '2026-10-16T01:45:00Z', { day: '2026-10-16', aic_today: 5, dry_run: true }),
    ];
    assert.equal(deriveState(notToday, NOW).factory_aic_today, null);
  });

  it('with a spend_snapshot for today: the larger of the newest snapshot and the run_finished sum', () => {
    const snap = (ts: string, aic: number) => ev('spend_snapshot', ts, { day: '2026-10-16', aic_today: aic });
    assert.equal(deriveState([snap('2026-10-16T00:05:00Z', 0)], NOW).factory_aic_today, 0);
    assert.equal(deriveState([snap('2026-10-16T01:00:00Z', 300), snap('2026-10-16T02:00:00Z', 120), ev('run_finished', '2026-10-16T02:30:00Z', { aic: 40 })], NOW).factory_aic_today, 120);
    assert.equal(deriveState([snap('2026-10-16T01:00:00Z', 20), ev('run_finished', '2026-10-16T02:30:00Z', { aic: 40 })], NOW).factory_aic_today, 40);
  });

  it('derives picked_at, repairs, signatures and spend from real events', () => {
    const d = deriveState(
      [
        ev('dispatched', '2026-10-15T09:00:00Z', { task: 'en/a' }),
        ev('run_finished', '2026-10-15T09:30:00Z', { task: 'en/a', aic: 100 }),
        ev('repair_dispatched', '2026-10-16T01:00:00Z', { task: 'en/a', run_id: 9, failure_signature: 'sig' }),
        ev('run_finished', '2026-10-16T02:00:00Z', { task: 'en/a', aic: 40 }),
        ev('run_finished', '2026-10-16T03:00:00Z', { aic: 10 }),
        ev('spend_snapshot', '2026-10-16T00:05:00Z', { day: '2026-10-16', aic_today: 0 }),
      ],
      NOW,
    );
    assert.deepEqual(d.history['en/a'], { picked_at: '2026-10-15T09:00:00Z', repairs: 1, failure_signatures: ['sig'], repaired_run_ids: [9], aic_spent: 140 });
    assert.equal(d.factory_aic_today, 50);
  });
});
