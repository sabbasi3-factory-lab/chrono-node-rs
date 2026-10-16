import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertAllowedRequest } from '../github.ts';
import { AUDIT_BRANCH, splitLines, verify } from '../audit.ts';
import { DRY_RUN, decisionEvent, describe as describeDecision, execute } from '../executor.ts';
import { FakeGitHub, type RecordedCall } from '../fake.ts';
import { parseArgs, run, type RunDeps } from '../main.ts';
import type { Snapshot } from '../types.ts';
import { checkRun, commitSha, contract, hex40, history, issue, NOW, pull, REPO, snapshot, testPolicies } from './helpers.ts';
import { dedupeKey } from '../audit.ts';
import { fakeWorld, seedSpendSnapshot } from './world.ts';

const policies = await testPolicies();
const FV = '320c4fcedefc03648caa4cda140bd93932367986';
const controllerDir = fileURLToPath(new URL('..', import.meta.url));

function deps(client: FakeGitHub, over: Partial<RunDeps> = {}): RunDeps {
  return {
    client,
    repo: REPO,
    policies,
    factoryVersion: FV,
    env: { FACTORY_ENABLED: 'true', GITHUB_RUN_ID: '123', GITHUB_EVENT_NAME: 'schedule' },
    now: NOW,
    log: () => {},
    ...over,
  };
}

const AUDIT_WRITE = new RegExp(`^/repos/${REPO}/git/(blobs|trees|commits|refs|refs/heads/${AUDIT_BRANCH})$`);

function assertOnlyReadsAndAuditWrites(calls: RecordedCall[]): void {
  for (const c of calls) {
    if (c.method === 'GET') continue;
    const path = c.path.split('?')[0]!;
    const body = (c.body ?? {}) as Record<string, unknown>;
    if (c.method === 'POST' && path === '/graphql') {
      assert.match(String(body.query), /^\s*query\b/, 'GraphQL must be a query');
      continue;
    }
    assert.match(path, AUDIT_WRITE, `unexpected mutating call ${c.method} ${path}`);
    if (path.endsWith('/git/refs')) assert.equal(body.ref, `refs/heads/${AUDIT_BRANCH}`);
    if (c.method === 'PATCH') {
      assert.equal(path, `/repos/${REPO}/git/refs/heads/${AUDIT_BRANCH}`);
      assert.equal(body.force, false);
    } else {
      assert.equal(c.method, 'POST', `unexpected method ${c.method}`);
    }
    assert.doesNotThrow(() => assertAllowedRequest(REPO, c.method, c.path, c.body));
  }
}

describe('main: dry-run enforcement', () => {
  it('DRY_RUN is a hard-wired constant', () => {
    assert.equal(DRY_RUN, true);
  });

  for (const enabled of ['true', undefined]) {
    it(`never calls a mutating endpoint except audit-branch Git Data writes (FACTORY_ENABLED=${String(enabled)})`, async () => {
      const gh = fakeWorld();
      const result = await run(deps(gh, { env: { FACTORY_ENABLED: enabled, GITHUB_RUN_ID: '1', GITHUB_EVENT_NAME: 'schedule' } }));
      assert.ok(result.appended.length > 0);
      assert.ok(result.decisions.length > 0);
      assertOnlyReadsAndAuditWrites(gh.calls);
      const writes = gh.calls.filter((c) => c.method !== 'GET' && c.path !== '/graphql');
      // Exactly 4 Git Data calls per event (blob, tree, commit, ref).
      assert.equal(writes.length, result.appended.length * 4);
    });
  }

  it('records dispatch decisions as dry-run events and takes no effect', async () => {
    const gh = fakeWorld();
    await seedSpendSnapshot(gh, '2026-10-16T00:05:00Z');
    const lines: string[] = [];
    const result = await run(deps(gh, { log: (l) => lines.push(l) }));
    const dispatched = result.appended.find((e) => e.type === 'dispatched');
    assert.ok(dispatched);
    assert.equal(dispatched.payload.reason, 'would_dispatch');
    assert.equal(dispatched.payload.dry_run, true);
    assert.ok(lines.some((l) => l.startsWith('[dry-run] would dispatch_workflow:implement')));
    assert.ok(!gh.calls.some((c) => /dispatches|labels|comments|merge|issues\/\d+$/.test(c.path) && c.method !== 'GET'));
  });

  it('writes a verifiable audit file without free text', async () => {
    const gh = fakeWorld();
    await seedSpendSnapshot(gh, '2026-10-16T00:05:00Z');
    const result = await run(deps(gh));
    const file = gh.fileAt(AUDIT_BRANCH, 'audit/2026/10/16.jsonl')!;
    const ls = splitLines(file);
    assert.equal(ls.length, result.appended.length + 1); // + the seeded spend_snapshot
    assert.ok(verify(ls, null).ok);
    assert.ok(!file.includes('Free text') && !file.includes('Ignore previous'));
    const types = result.appended.map((e) => e.type);
    for (const t of ['pr_opened', 'check_result', 'queued', 'human_action', 'dispatched', 'heartbeat']) assert.ok(types.includes(t), t);
    const cr = result.appended.find((e) => e.type === 'check_result')!;
    assert.equal(cr.payload.heldout_seed, '9007199254740993');
    for (const e of result.appended) {
      assert.equal(e.payload.dry_run, true);
      assert.equal(e.payload.factory_version, FV);
      assert.match(String(e.payload.dedupe_key), /^sha256:[0-9a-f]{64}$/);
    }
  });

  it('is idempotent: a retried run records nothing twice', async () => {
    const gh = fakeWorld();
    const first = await run(deps(gh));
    const second = await run(deps(gh, { now: new Date(NOW.getTime() + 5 * 60_000) }));
    assert.ok(first.appended.length > 0);
    assert.deepEqual(second.appended, []);
    assert.ok(!gh.calls.slice(-30).some((c) => c.path.includes('/logs')), 'logs of recorded runs are not re-read');
  });

  it('writes the next heartbeat once ≥ 55 minutes have passed and the UTC hour is new', async () => {
    const gh = fakeWorld();
    await run(deps(gh));
    // 56 min later but still hour 12 → the hour-bucket dedupe key already exists.
    const sameHour = await run(deps(gh, { now: new Date(NOW.getTime() + 56 * 60_000) }));
    assert.deepEqual(sameHour.appended, []);
    const nextHour = await run(deps(gh, { now: new Date(NOW.getTime() + 61 * 60_000) }));
    assert.deepEqual(nextHour.appended.map((e) => e.type), ['heartbeat']);
    assert.equal(nextHour.appended[0]!.payload.hour, '2026-10-16T13');
    const soon = await run(deps(gh, { now: new Date(NOW.getTime() + 100 * 60_000) }));
    assert.deepEqual(soon.appended, [], '39 min after the last heartbeat → not due');
  });

  it('heartbeat payload carries run id, counts and kill switch state', async () => {
    const result = await run(deps(new FakeGitHub(REPO), { snapshot: emptySnapshot(), env: { GITHUB_RUN_ID: '42', GITHUB_EVENT_NAME: 'schedule' } }));
    const hb = result.appended.at(-1)!;
    assert.equal(hb.type, 'heartbeat');
    assert.deepEqual(
      { run_id: hb.payload.run_id, open_pr_count: hb.payload.open_pr_count, decision_count: hb.payload.decision_count, factory_enabled: hb.payload.factory_enabled, trigger: hb.payload.trigger },
      { run_id: 42, open_pr_count: 0, decision_count: 0, factory_enabled: false, trigger: 'schedule' },
    );
  });

  it('Stage 0 (no factory issues) appends only the heartbeat', async () => {
    const result = await run(deps(new FakeGitHub(REPO), { snapshot: emptySnapshot() }));
    assert.deepEqual(result.decisions, []);
    assert.deepEqual(result.appended.map((e) => e.type), ['heartbeat']);
    assert.match(result.summary, /No decisions/);
  });

  it('renders a markdown summary table', async () => {
    const gh = fakeWorld();
    await seedSpendSnapshot(gh, '2026-10-16T00:05:00Z');
    const result = await run(deps(gh));
    assert.match(result.summary, /\| # \| type \| reason \| would \| task \| issue \| PR \|/);
    assert.match(result.summary, /\| dispatched \| would_dispatch \| dispatch_workflow:implement \| en\/casual-date \| #10 \|/);
  });
});

describe('executor', () => {
  it('only logs, never acts', () => {
    const d = { type: 'needs_human', reason: 'task_timeout', effect: 'label:needs-human', dry_run: true, task: 'en/a', issue: 1, pr: null, attempt: null, contract_sha: null, run_id: null, failure_signature: null, source_ids: ['I_1'] } as const;
    const out: string[] = [];
    execute([{ ...d, source_ids: [...d.source_ids] }], (l) => out.push(l));
    assert.deepEqual(out, ['[dry-run] would label:needs-human (needs_human/task_timeout) task=en/a issue=#1']);
    assert.equal(execute.length, 2, 'executor takes decisions + logger only (no client)');
    assert.equal(describeDecision({ ...d, source_ids: [], type: 'wait', reason: 'wip_full', effect: 'none' }), '[dry-run] wait (wip_full) task=en/a issue=#1');
    assert.deepEqual(decisionEvent({ ...d, source_ids: ['I_1'] }).fields, { reason: 'task_timeout', effect: 'label:needs-human', task: 'en/a', issue: 1 });
    assert.throws(() => decisionEvent({ ...d, source_ids: ['I_1'], type: 'wait' }), /not recorded/);
  });
});

describe('CLI', () => {
  it('parses arguments strictly', () => {
    assert.deepEqual(parseArgs(['--fixture', 'x.json', '--print']), { fixture: 'x.json', print: true, now: null });
    assert.throws(() => parseArgs(['--execute']), /unknown argument/);
  });

  it('runs the fixture mode end to end without credentials', () => {
    const env: NodeJS.ProcessEnv = { ...process.env, FACTORY_ENABLED: 'true' };
    delete env.GH_TOKEN;
    delete env.GITHUB_STEP_SUMMARY;
    const r = spawnSync(process.execPath, ['main.ts', '--fixture', 'test/fixtures/snapshot.json', '--print'], { cwd: controllerDir, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const eventLines = r.stdout.split('\n').filter((l) => l.startsWith('{'));
    assert.ok(eventLines.length >= 5);
    assert.ok(verify(eventLines, null).ok);
    assert.match(r.stdout, /would dispatch_workflow:implement/);
  });

  it('fails closed (exit 1, nothing written) without a repository or token', () => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of ['GH_TOKEN', 'GITHUB_REPOSITORY', 'GITHUB_STEP_SUMMARY']) delete env[k];
    const r = spawnSync(process.execPath, ['main.ts'], { cwd: controllerDir, env, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /fail closed/);
  });
});

describe('fixture snapshot', () => {
  it('is a valid Snapshot that produces decisions', async () => {
    const s = JSON.parse(await readFile(new URL('./fixtures/snapshot.json', import.meta.url), 'utf8')) as Snapshot;
    const result = await run(deps(new FakeGitHub(REPO), { snapshot: s, now: new Date(s.fetched_at) }));
    assert.ok(result.decisions.some((d) => d.reason === 'contract_changed'));
    assert.ok(result.decisions.some((d) => d.reason === 'deps_not_merged'));
  });
});

function emptySnapshot(): Snapshot {
  return { repo: REPO, fetched_at: '2026-10-16T12:00:00Z', issues: [], pulls: [], main_sha: null, contracts: {}, check_runs: [], unchecked_heads: [], busy_jobs: null, factory_aic_today: null, history: {} };
}

describe('review fix 1: one bad input cannot stop the run before the heartbeat', () => {
  it('logs and skips an event that fails validation, then still writes the heartbeat', async () => {
    const pr = pull(21, { task_id: 'en/a', contract_sha: commitSha('en/a') });
    const s = snapshot({
      issues: [issue(1, 'en/a', ['factory:picked'])],
      pulls: [pr],
      contractList: [contract('en/a')],
      check_runs: [
        checkRun(490, { workflow: 'gates', event: 'pull_request_target', head_sha: hex40('e'), candidate_sha: pr.head_sha, conclusion: 'success' }),
        checkRun(500, { head_sha: pr.head_sha, conclusion: 'failure', failure_signature: 'not a token' }),
      ],
      history: { 'en/a': history({ picked_at: '2026-10-16T10:00:00Z' }) },
    });
    const lines: string[] = [];
    const result = await run(deps(new FakeGitHub(REPO), { snapshot: s, log: (l) => lines.push(l) }));
    assert.ok(result.decisions.some((d) => d.type === 'repair_dispatched'), 'the planner proposed the bad decision');
    const types = result.appended.map((e) => e.type);
    assert.ok(!types.includes('repair_dispatched'), 'the invalid decision event was skipped');
    assert.ok(!result.appended.some((e) => e.type === 'check_result' && e.payload.run_id === 500), 'the invalid observed event was skipped');
    assert.ok(types.includes('pr_opened'), 'valid events are still recorded');
    assert.equal(types.at(-1), 'heartbeat');
    assert.ok(lines.some((l) => l.startsWith('skipped invalid audit event (repair_dispatched:')));
    assert.ok(lines.some((l) => l === 'skipped 2 invalid audit event(s)'));
  });
});

describe('review fix 2: decision dedupe includes reason and effect', () => {
  const base = { type: 'blocked', reason: 'missing_task_marker', effect: 'label:blocked', dry_run: true, task: null, issue: 12, pr: null, attempt: null, contract_sha: null, run_id: null, failure_signature: null, source_ids: ['I_12'] } as const;
  const key = (d: Parameters<typeof decisionEvent>[0]) => {
    const e = decisionEvent(d);
    return dedupeKey(e.type, e.source_ids);
  };

  it('a different reason (or effect) for the same subject gets a different key; identical decisions share one', () => {
    const a = { ...base, source_ids: ['I_12'] };
    const b = { ...base, reason: 'contract_missing' as const, source_ids: ['I_12'] };
    const c = { ...base, effect: 'label:needs-human' as const, source_ids: ['I_12'] };
    assert.notEqual(key(a), key(b));
    assert.notEqual(key(a), key(c));
    assert.equal(key(a), key({ ...base, source_ids: ['I_12'] }));
    assert.deepEqual(decisionEvent(a).source_ids, ['I_12', 'reason:missing_task_marker', 'effect:label:blocked']);
  });

  it('records blocked/missing_task_marker then blocked/contract_missing for the same issue, and nothing on retry', async () => {
    const gh = new FakeGitHub(REPO);
    const first = snapshot({ issues: [issue(12, null)] });
    const second = snapshot({ issues: [issue(12, 'en/no-contract')] });
    const r1 = await run(deps(gh, { snapshot: first }));
    assert.deepEqual(r1.appended.filter((e) => e.type === 'blocked').map((e) => e.payload.reason), ['missing_task_marker']);
    const later = new Date(NOW.getTime() + 5 * 60_000);
    const r2 = await run(deps(gh, { snapshot: second, now: later }));
    assert.deepEqual(r2.appended.filter((e) => e.type === 'blocked').map((e) => e.payload.reason), ['contract_missing']);
    const r3 = await run(deps(gh, { snapshot: second, now: new Date(later.getTime() + 60_000) }));
    assert.deepEqual(r3.appended, []);
  });
});

describe('independent review (follow-up): spend fails closed end to end', () => {
  it('an empty audit log means unknown spend: nothing is dispatched, even with FACTORY_ENABLED=true', async () => {
    const lines: string[] = [];
    const result = await run(deps(fakeWorld(), { log: (l) => lines.push(l) }));
    assert.ok(!result.decisions.some((d) => d.type === 'dispatched'));
    assert.ok(result.decisions.some((d) => d.type === 'wait' && d.reason === 'budget_unknown'));
    assert.ok(!result.appended.some((e) => e.type === 'dispatched'));
  });
});
