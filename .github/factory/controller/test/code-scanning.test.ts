import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { codeScanningGate, plan } from '../planner.ts';
import { readCodeScanning } from '../github.ts';
import { FakeGitHub } from '../fake.ts';
import type { CodeScanningSnap, Policies, Snapshot } from '../types.ts';
import { checkRun, contract, hex40, history, issue, NOW, pull, REPO, snapshot, testPolicies } from './helpers.ts';

const base = await testPolicies();
const waiting = (on = true): Policies => ({ ...base, limits: { ...base.limits, ci: { ...base.limits.ci, wait_for_code_scanning: on } } });
const ON = { FACTORY_ENABLED: 'true' };
const HEAD = hex40('1');
const analyze = (conclusion: string | null, status = 'completed', run_attempt: number | null = 1) =>
  ['actions', 'javascript-typescript', 'rust'].map((l, i) => ({ name: `Analyze (${l})`, status, conclusion: i === 2 ? conclusion : status === 'completed' ? 'success' : null, run_id: 4242, run_attempt }));
const cs = (over: Partial<CodeScanningSnap> = {}): CodeScanningSnap => ({ head_sha: HEAD, codeql: null, analyze: analyze(null, 'in_progress'), ...over });

/** A green, eligible auto-tier agent PR (the merge stage's own fixture shape), with code scanning `scan`. */
const world = (scan: CodeScanningSnap[] | undefined): Snapshot => {
  const c = contract('en/weekday-parser');
  const pr = pull(21, { task_id: 'en/weekday-parser', contract_sha: c.last_commit_sha, mergeable: 'MERGEABLE', in_merge_queue: false });
  return {
    ...snapshot({
      issues: [issue(1, 'en/weekday-parser', ['factory:ready', 'factory:picked'])],
      pulls: [pr],
      contractList: [c],
      check_runs: [
        checkRun(490, { workflow: 'gates', event: 'pull_request_target', head_sha: hex40('e'), candidate_sha: pr.head_sha, conclusion: 'success' }),
        checkRun(500, { head_sha: pr.head_sha, pull_requests: [21], conclusion: 'success', created_at: '2026-10-16T11:00:00Z' }),
      ],
      history: { 'en/weekday-parser': history({ picked_at: '2026-10-16T10:00:00Z' }) },
    }),
    ...(scan ? { code_scanning: scan } : {}),
  };
};
const kinds = (s: Snapshot, p = waiting()) => plan(s, p, ON, NOW).map((d) => `${d.type}/${d.reason}`);

describe('merge stage: wait for code scanning (limits.ci.wait_for_code_scanning)', () => {
  it('off (the default): queued as before, without reading code scanning', () => {
    assert.equal(base.limits.ci.wait_for_code_scanning, false);
    assert.deepEqual(kinds(world(undefined), base), ['auto_merge/auto_merge_ready']);
  });

  it('on: CodeQL passed on the head → queued', () => {
    assert.deepEqual(kinds(world([cs({ codeql: { status: 'completed', conclusion: 'success' }, analyze: analyze('success') })])), ['auto_merge/auto_merge_ready']);
  });

  it('on: no result yet, analysis running, or the head unread → wait (merge_not_ready), never an enqueue the ruleset refuses', () => {
    for (const scan of [[], [cs()], [cs({ codeql: { status: 'in_progress', conclusion: null } })]]) {
      const ds = plan(world(scan), waiting(), ON, NOW);
      assert.deepEqual(ds.map((d) => `${d.type}/${d.reason}`), ['wait/merge_not_ready']);
      assert.ok(ds[0]!.source_ids.some((x) => x === 'blocker:code_scanning_pending' || x === 'blocker:code_scanning_unknown'));
    }
  });

  it('on: CodeQL found alerts above the threshold → needs-human (code_scanning_alerts)', () => {
    assert.deepEqual(kinds(world([cs({ codeql: { status: 'completed', conclusion: 'failure' }, analyze: analyze('success') })])), ['needs_human/code_scanning_alerts']);
  });

  it('on: an Analyze job failed (e.g. API rate limit) → one re-run of that run; failed again → needs-human', () => {
    const ds = plan(world([cs({ analyze: analyze('failure') })]), waiting(), ON, NOW);
    assert.deepEqual(ds.map((d) => [`${d.type}/${d.reason}`, d.effect, d.run_id]), [['code_scanning_rerun/code_scanning_failed', 'rerun_ci', 4242]]);
    assert.deepEqual(kinds(world([cs({ analyze: analyze('failure', 'completed', 2) })])), ['needs_human/code_scanning_failed']);
    assert.deepEqual(kinds(world([cs({ analyze: analyze('failure', 'completed', null) })])), ['needs_human/code_scanning_failed']);
    // The kill switch holds the re-run too.
    assert.ok(!plan(world([cs({ analyze: analyze('failure') })]), waiting(), { FACTORY_ENABLED: undefined }, NOW).some((d) => d.effect === 'rerun_ci'));
  });

  it('codeScanningGate: a passed CodeQL check wins over an older failed Analyze job', () => {
    assert.deepEqual(codeScanningGate({ code_scanning: [cs({ codeql: { status: 'completed', conclusion: 'success' }, analyze: analyze('failure') })] } as Snapshot, HEAD), { kind: 'pass' });
  });

  it('readCodeScanning: the CodeQL check from GitHub Advanced Security only, Analyze jobs with their run, the attempt of a failed one', async () => {
    const gh = new FakeGitHub(REPO);
    const r = `/repos/${REPO}`;
    gh.addRoute('GET', new RegExp(`^${r}/commits/${HEAD}/check-runs$`), () => ({
      data: {
        check_runs: [
          { id: 1, name: 'CodeQL', head_sha: HEAD, status: 'completed', conclusion: 'success', app: { id: 999 } },
          { id: 2, name: 'Analyze (rust)', head_sha: HEAD, status: 'completed', conclusion: 'failure', app: { id: 15368 }, details_url: `https://github.com/${REPO}/actions/runs/4242/job/77` },
          { id: 3, name: 'Analyze (actions)', head_sha: HEAD, status: 'completed', conclusion: 'success', app: { id: 15368 }, details_url: `https://github.com/${REPO}/actions/runs/4242/job/78` },
        ],
      },
    }));
    gh.addRoute('GET', new RegExp(`^${r}/actions/runs/4242$`), () => ({ data: { id: 4242, run_attempt: 2, status: 'completed' } }));
    const [x] = await readCodeScanning(gh, REPO, [HEAD]);
    assert.equal(x!.codeql, null, 'a CodeQL-named check from another app is ignored');
    assert.deepEqual(x!.analyze.map((a) => [a.name, a.conclusion, a.run_id, a.run_attempt]), [['Analyze (rust)', 'failure', 4242, 2], ['Analyze (actions)', 'success', 4242, null]]);
  });

  it('readCodeScanning: an old failed job while a re-run is in progress counts as running, not as a failed attempt 2 (review fix)', async () => {
    const gh = new FakeGitHub(REPO);
    const r = `/repos/${REPO}`;
    gh.addRoute('GET', new RegExp(`^${r}/commits/${HEAD}/check-runs$`), () => ({
      data: { check_runs: [{ id: 2, name: 'Analyze (rust)', head_sha: HEAD, status: 'completed', conclusion: 'failure', app: { id: 15368 }, details_url: `https://github.com/${REPO}/actions/runs/4242/job/77` }] },
    }));
    gh.addRoute('GET', new RegExp(`^${r}/actions/runs/4242$`), () => ({ data: { id: 4242, run_attempt: 2, status: 'in_progress' } }));
    const scan = await readCodeScanning(gh, REPO, [HEAD]);
    assert.deepEqual(scan[0]!.analyze.map((a) => [a.status, a.conclusion, a.run_attempt]), [['in_progress', null, null]]);
    assert.deepEqual(codeScanningGate({ code_scanning: scan } as Snapshot, HEAD), { kind: 'wait', why: 'code_scanning_pending' });
  });
});
