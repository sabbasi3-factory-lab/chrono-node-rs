// The outcomes workflow's selection (.github/factory/outcomes/select.jq): its API budget depends on it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const SELECT = new URL('../../outcomes/select.jq', import.meta.url).pathname;
const NOW = '2026-11-04T18:00:00Z';
const DAY = '2026-11-03T18:00:00Z';
const CUT = '2026-10-21T18:00:00Z';

type Run = { run_id: number; workflow: string; title: string; created_at: string };
const run = (id: number, created = '2026-11-04T10:00:00Z'): Run => ({ run_id: id, workflow: 'implement', title: 'Implement en/x #1 attempt 1', created_at: created });
const rec = (id: number, status: string, evaluated_at?: string, pr = 900 + id, extra: Record<string, unknown> = {}) => ({
  run_id: id,
  items: [{ type: 'create_pull_request', object_url: `https://github.com/o/r/pull/${pr}`, outcome_status: status }],
  ...(evaluated_at ? { evaluated_at } : {}),
  ...extra,
});

function select(listed: Run[], prev: unknown, prs: unknown[] = [], max = 3, full = false): number[] {
  const d = mkdtempSync(join(tmpdir(), 'sel-'));
  writeFileSync(join(d, 'l.json'), JSON.stringify(listed));
  writeFileSync(join(d, 'p.json'), JSON.stringify(prev));
  writeFileSync(join(d, 'prs.json'), JSON.stringify(prs));
  const out = execFileSync('jq', ['-r', '-f', SELECT, '--slurpfile', 'p', join(d, 'p.json'), '--slurpfile', 'prs', join(d, 'prs.json'), '--arg', 'full', String(full), '--arg', 'now', NOW, '--arg', 'cut', CUT, '--arg', 'day', DAY, '--arg', 'max', String(max), join(d, 'l.json')], { encoding: 'utf8' });
  return out.split('\n').filter(Boolean).map(Number);
}

describe('outcomes selection (select.jq)', () => {
  it('a pending item is re-checked at most once a day; a settled one never', () => {
    const prev = { generated_at: '2026-11-04T17:00:00Z', runs: [rec(1, 'pending', '2026-11-04T12:00:00Z'), rec(2, 'pending', '2026-11-03T12:00:00Z'), rec(3, 'accepted', '2026-11-01T00:00:00Z')] };
    assert.deepEqual(select([run(1), run(2), run(3)], prev), [2]);
  });

  it('a record from before evaluated_at existed counts as evaluated when the previous file was generated (no burst)', () => {
    assert.deepEqual(select([run(1)], { generated_at: '2026-11-04T17:00:00Z', runs: [rec(1, 'pending')] }), []);
    assert.deepEqual(select([run(1)], { generated_at: '2026-11-02T17:00:00Z', runs: [rec(1, 'pending')] }), [1]);
  });

  it('a run whose PR closed after its last evaluation goes first; then new runs; then due pending; at most max', () => {
    const prev = { generated_at: NOW, runs: [rec(1, 'pending', '2026-11-04T17:00:00Z', 50), rec(2, 'pending', '2026-11-02T00:00:00Z'), rec(3, 'pending', '2026-11-01T00:00:00Z')] };
    const prs = [{ number: 50, closedAt: '2026-11-04T17:30:00Z' }];
    assert.deepEqual(select([run(1), run(2), run(3), run(4), run(5)], prev, prs, 3), [1, 4, 5]);
    assert.deepEqual(select([run(1), run(2), run(3), run(4), run(5)], prev, prs, 10), [1, 4, 5, 3, 2]);
    // Closed before the last evaluation: already seen, waits for its daily re-check.
    assert.deepEqual(select([run(1)], prev, [{ number: 50, closedAt: '2026-11-04T16:00:00Z' }]), []);
  });

  it('failed evaluations retry daily; runs over 14 days old are left; full takes everything', () => {
    const prev = { generated_at: NOW, runs: [rec(1, 'accepted', '2026-11-03T00:00:00Z', 1, { eval_failed: true }), rec(2, 'pending', '2026-10-01T00:00:00Z')] };
    assert.deepEqual(select([run(1), run(2, '2026-10-01T00:00:00Z')], prev), [1]);
    assert.deepEqual(select([run(1), run(2, '2026-10-01T00:00:00Z')], prev, [], 3, true).sort(), [1, 2]);
  });

  it('budget: a burst of 40 new runs is evaluated 3 at a time', () => {
    const listed = Array.from({ length: 40 }, (_, i) => run(100 + i, `2026-11-04T1${i % 10}:00:00Z`));
    assert.equal(select(listed, { generated_at: NOW, runs: [] }).length, 3);
  });

  it('a PR rejected, then reopened and merged later, is re-selected whatever its previous verdict (review fix)', () => {
    const prev = { generated_at: NOW, runs: [rec(1, 'rejected', '2026-11-04T12:00:00Z', 50)] };
    assert.deepEqual(select([run(1)], prev, [{ number: 50, closedAt: '2026-11-04T17:00:00Z' }]), [1]);
    assert.deepEqual(select([run(1)], prev, [{ number: 50, closedAt: '2026-11-04T11:00:00Z' }]), []);
  });

  it('a tried run with no artifacts (recorded with no items) is never "new" again (review fix)', () => {
    const prev = { generated_at: NOW, runs: [{ run_id: 1, items: [], eval_failed: false, evaluated_at: '2026-11-04T17:00:00Z' }] };
    assert.deepEqual(select([run(1), run(2)], prev), [2]);
  });
});

