import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertAllowedRequest, COMMENT_MARKER, ENQUEUE_MUTATION, PROJECT_STATUS_MUTATION } from '../github.ts';
import { AUDIT_BRANCH, splitLines, verify } from '../audit.ts';
import { decisionEvent, describe as describeDecision, execute, executeLive, isLive, liveDecision, pendingHandoffs } from '../executor.ts';
import { FakeGitHub, type RecordedCall } from '../fake.ts';
import { parseArgs, run, type RunDeps } from '../main.ts';
import { deriveState } from '../history.ts';
import { readReviewChecks, REVIEWER_APP_ID } from '../github.ts';
import type { Snapshot } from '../types.ts';
import { checkRun, commitSha, contract, hex40, history, issue, mergedPull, NOW, pull, REPO, snapshot, testPolicies } from './helpers.ts';
import { dedupeKey } from '../audit.ts';
import { CONTRACT_COMMIT, fakeWorld, projectNode, seedSpendSnapshot, type ProjectWorld } from './world.ts';

const policies = await testPolicies();

/** fakeWorld with one completed implement run today whose agent ran but left no usage artifact. */
function unreadableSpendWorld(): ProjectWorld {
  const gh = fakeWorld();
  const r = `/repos/${REPO}`;
  gh.routes.unshift(
    { method: 'GET', path: new RegExp(`^${r}/actions/workflows/implement\\.lock\\.yml/runs$`), handler: () => ({ data: { workflow_runs: [{ id: 900, run_attempt: 1, status: 'completed', conclusion: 'success', created_at: '2026-10-16T09:00:00Z' }] } }) },
    { method: 'GET', path: new RegExp(`^${r}/actions/runs/900/attempts/1/jobs$`), handler: () => ({ data: { jobs: [{ name: 'agent', steps: [{ name: 'Execute GitHub Copilot CLI', conclusion: 'success' }] }] } }) },
    { method: 'GET', path: new RegExp(`^${r}/actions/runs/900/artifacts$`), handler: () => ({ data: { artifacts: [] } }) },
  );
  return gh;
}
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
    // The planner sees FACTORY_ENABLED=true (so it plans dispatches), but these tests check the
    // dry-run path. Tests of the real switch set forceDryRun: false.
    forceDryRun: true,
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
  it('is live only when FACTORY_ENABLED is exactly "true"', () => {
    assert.equal(isLive({ FACTORY_ENABLED: 'true' }), true);
    for (const v of [undefined, '', 'false', 'TRUE', 'True', 'true ', ' true', '1', 'yes', 'on']) assert.equal(isLive({ FACTORY_ENABLED: v }), false, String(v));
  });

  // The switch-off case: dry-run stays on, exactly as v1.
  for (const enabled of [undefined, 'false', 'TRUE', 'true ', '1']) {
    it(`dry-run stays on: no mutating call except audit-branch Git Data writes, every event dry_run (FACTORY_ENABLED=${JSON.stringify(enabled)})`, async () => {
      const gh = fakeWorld();
      await seedSpendSnapshot(gh, '2026-10-16T00:05:00Z');
      const result = await run(deps(gh, { env: { FACTORY_ENABLED: enabled, GITHUB_RUN_ID: '1', GITHUB_EVENT_NAME: 'schedule' }, forceDryRun: false }));
      assert.equal(result.live, false);
      assert.ok(result.appended.length > 0);
      assert.ok(result.decisions.length > 0);
      assertOnlyReadsAndAuditWrites(gh.calls);
      for (const c of gh.calls) assert.doesNotThrow(() => assertAllowedRequest(REPO, c.method, c.path, c.body, 'dry-run'));
      // Every event is dry-run except the spend measurement, which is a fact in both modes.
      for (const e of result.appended) assert.equal(e.payload.dry_run, e.type !== 'spend_snapshot', e.type);
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
      assert.equal(e.payload.dry_run, e.type !== 'spend_snapshot');
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
  it('dry-run only logs, never acts', () => {
    const d = { type: 'needs_human', reason: 'task_timeout', effect: 'label:needs-human', dry_run: true, task: 'en/a', issue: 1, pr: null, attempt: null, contract_sha: null, run_id: null, failure_signature: null, source_ids: ['I_1'] } as const;
    const out: string[] = [];
    execute([{ ...d, source_ids: [...d.source_ids] }], (l) => out.push(l));
    assert.deepEqual(out, ['[dry-run] would label:needs-human (needs_human/task_timeout) task=en/a issue=#1']);
    assert.equal(execute.length, 2, 'the dry-run executor takes decisions + logger only (no client)');
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
  it('unreadable spend (a completed run without its usage artifact) means nothing is dispatched, even with FACTORY_ENABLED=true', async () => {
    const lines: string[] = [];
    const result = await run(deps(unreadableSpendWorld(), { log: (l) => lines.push(l) }));
    assert.ok(lines.some((l) => l.startsWith('spend today: unknown: run 900 has 0 usage artifacts')));
    assert.ok(!result.appended.some((e) => e.type === 'spend_snapshot'));
    assert.ok(!result.decisions.some((d) => d.type === 'dispatched'));
    assert.ok(result.decisions.some((d) => d.type === 'wait' && d.reason === 'budget_unknown'));
    assert.ok(!result.appended.some((e) => e.type === 'dispatched'));
  });
});

// ---------------------------------------------------------------- live mode

const LIVE_ENV = { FACTORY_ENABLED: 'true', GITHUB_RUN_ID: '42', GITHUB_EVENT_NAME: 'schedule' };

/**
 * fakeWorld + routes for the three live writes. `dispatchStatus` simulates a failed dispatch;
 * `failComments` makes the next N comment POSTs fail. Comments persist across runs (GET lists them).
 */
type LiveWorld = ProjectWorld & { comments: Map<number, string[]>; closed: number[]; removed: string[]; statusUpdates: unknown[]; failClose: number };

function liveWorld(dispatchStatus = 204, failComments = 0, base: ProjectWorld = fakeWorld()): LiveWorld {
  const gh = base as LiveWorld;
  gh.comments = new Map();
  gh.closed = [];
  gh.removed = [];
  gh.statusUpdates = [];
  gh.failClose = 0;
  gh.addRoute('DELETE', new RegExp(`^/repos/${REPO}/issues/\\d+/labels/[^/]+$`), (path) => {
    gh.removed.push(decodeURIComponent(path.replace(`/repos/${REPO}/issues/`, '#').replace('/labels/', ' ')));
    return { data: [] };
  });
  gh.addRoute('PATCH', new RegExp(`^/repos/${REPO}/issues/\\d+$`), (path) => {
    if (gh.failClose > 0) {
      gh.failClose--;
      return { status: 502, data: null };
    }
    gh.closed.push(Number(path.split('/').pop()));
    return { data: {} };
  });
  // Project status updates first; every other GraphQL request goes to fakeWorld's route.
  const graphqlRoute = gh.routes.find((r) => r.method === 'POST' && r.path.source === '^\\/graphql$')!;
  gh.routes.unshift({
    method: 'POST',
    path: /^\/graphql$/,
    handler: (p, body) => {
      if ((body as { query?: unknown }).query !== PROJECT_STATUS_MUTATION) return graphqlRoute.handler(p, body);
      gh.statusUpdates.push((body as { variables: unknown }).variables);
      return { data: { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'x' } } } } };
    },
  });
  let failures = failComments;
  gh.addRoute('POST', new RegExp(`^/repos/${REPO}/issues/\\d+/labels$`), () => ({ data: [] }));
  gh.addRoute('POST', new RegExp(`^/repos/${REPO}/issues/\\d+/comments$`), (path, body) => {
    if (failures > 0) {
      failures--;
      return { status: 502, data: null };
    }
    const n = Number(/issues\/(\d+)\/comments/.exec(path)![1]);
    gh.comments.set(n, [...(gh.comments.get(n) ?? []), (body as { body: string }).body]);
    return { status: 201, data: { id: 1 } };
  });
  gh.addRoute('GET', new RegExp(`^/repos/${REPO}/issues/\\d+/comments$`), (path) => {
    const n = Number(/issues\/(\d+)\/comments/.exec(path)![1]);
    return { data: (gh.comments.get(n) ?? []).map((body, i) => ({ id: i + 1, body })) };
  });
  gh.addRoute('POST', new RegExp(`^/repos/${REPO}/actions/workflows/implement\\.lock\\.yml/dispatches$`), () => ({ status: dispatchStatus, data: null }));
  return gh;
}
const effectCalls = (gh: FakeGitHub) => gh.calls.filter((c) => c.method === 'POST' && !/\/git\/|^\/graphql$/.test(c.path));

describe('main: live mode (FACTORY_ENABLED=true)', () => {
  it('labels the issue picked, then dispatches implement on main, then records it (dry_run: false)', async () => {
    const gh = liveWorld();
    await seedSpendSnapshot(gh, '2026-10-16T00:05:00Z');
    const lines: string[] = [];
    const result = await run(deps(gh, { env: LIVE_ENV, forceDryRun: false, runUrl: 'https://github.com/x/y/actions/runs/42', log: (l) => lines.push(l) }));
    assert.equal(result.live, true);
    assert.ok(lines.includes('mode: live (FACTORY_ENABLED=true)'));
    const calls = effectCalls(gh).map((c) => [c.path, c.body]);
    const pick = calls.findIndex(([p]) => p === `/repos/${REPO}/issues/10/labels`);
    const dispatch = calls.findIndex(([p]) => String(p).endsWith('/implement.lock.yml/dispatches'));
    assert.ok(pick >= 0 && dispatch > pick, 'factory:picked is added before the dispatch');
    assert.deepEqual(calls[pick]![1], { labels: ['factory:picked'] });
    assert.deepEqual(calls[dispatch]![1], { ref: 'main', inputs: { task: 'en/casual-date', issue: '10', attempt: '1', contract_sha: CONTRACT_COMMIT } });
    // Every call the controller made is on the live allowlist.
    for (const c of gh.calls) assert.doesNotThrow(() => assertAllowedRequest(REPO, c.method, c.path, c.body, 'live'), `${c.method} ${c.path}`);
    const dispatched = result.appended.find((e) => e.type === 'dispatched')!;
    assert.equal(dispatched.payload.dry_run, false);
    assert.equal(dispatched.payload.reason, 'would_dispatch');
    for (const e of result.appended) assert.equal(e.payload.dry_run, false, e.type);
  });

  it('a failed gates run: labels the PR needs-human and posts one templated comment', async () => {
    const gh = liveWorld();
    await seedSpendSnapshot(gh, '2026-10-16T00:05:00Z');
    await run(deps(gh, { env: LIVE_ENV, forceDryRun: false, runUrl: 'https://github.com/x/y/actions/runs/42' }));
    const calls = effectCalls(gh);
    assert.deepEqual(calls.find((c) => c.path === `/repos/${REPO}/issues/11/labels`)!.body, { labels: ['needs-human'] });
    const comment = calls.find((c) => c.path === `/repos/${REPO}/issues/11/comments`)!.body as { body: string };
    assert.ok(comment.body.startsWith(`${COMMENT_MARKER} · \`needs_human\` (\`gates_failed\`)`));
    assert.match(comment.body, /Run: https:\/\/github.com\/x\/y\/actions\/runs\/42/);
    assert.ok(!comment.body.includes('Ignore previous instructions'), 'no text from the PR body');
  });

  it('a second run takes no effect twice (audit dedupe and the pick time)', async () => {
    const gh = liveWorld();
    await seedSpendSnapshot(gh, '2026-10-16T00:05:00Z');
    await run(deps(gh, { env: LIVE_ENV, forceDryRun: false }));
    gh.calls.length = 0;
    await run(deps(gh, { env: LIVE_ENV, forceDryRun: false, now: new Date(NOW.getTime() + 5 * 60_000) }));
    assert.deepEqual(effectCalls(gh), []);
  });

  it('a failed dispatch fails the run after factory:picked, and records nothing (no double dispatch later)', async () => {
    const gh = liveWorld(500);
    await seedSpendSnapshot(gh, '2026-10-16T00:05:00Z');
    await assert.rejects(run(deps(gh, { env: LIVE_ENV, forceDryRun: false })), /dispatches: HTTP 500/);
    assert.ok(effectCalls(gh).some((c) => c.path === `/repos/${REPO}/issues/10/labels`));
    const file = gh.fileAt(AUDIT_BRANCH, 'audit/2026/10/16.jsonl') ?? '';
    assert.ok(!file.includes('"type":"dispatched"'));
  });

  it('with spend unknown nothing is dispatched (budget_unknown), even live', async () => {
    const gh = liveWorld(204, 0, unreadableSpendWorld());
    const result = await run(deps(gh, { env: LIVE_ENV, forceDryRun: false }));
    assert.ok(result.decisions.some((d) => d.type === 'wait' && d.reason === 'budget_unknown'));
    assert.ok(!effectCalls(gh).some((c) => c.path.endsWith('/dispatches')));
  });

  it('fixture mode stays dry-run even with FACTORY_ENABLED=true', async () => {
    const gh = liveWorld();
    await seedSpendSnapshot(gh, '2026-10-16T00:05:00Z');
    const result = await run(deps(gh, { env: LIVE_ENV, forceDryRun: true }));
    assert.equal(result.live, false);
    assert.deepEqual(effectCalls(gh), []);
  });

  it('a repair becomes needs_human/repair_unavailable (there is no repair workflow yet)', async () => {
    const base = { type: 'repair_dispatched', reason: 'ci_failed', effect: 'dispatch_workflow:repair', dry_run: true, task: 'en/a', issue: 3, pr: 21, attempt: 2, contract_sha: 'c'.repeat(40), run_id: 500, failure_signature: 's', source_ids: ['500/attempts/1', 'PR_21'] } as const;
    const d = { ...base, source_ids: [...base.source_ids] };
    assert.deepEqual([liveDecision(d).type, liveDecision(d).reason, liveDecision(d).effect], ['needs_human', 'repair_unavailable', 'label:needs-human']);
    const calls: { method: string; path: string; body: unknown }[] = [];
    const client = { request: async (method: string, path: string, o: { body?: unknown } = {}) => (calls.push({ method, path, body: o.body }), { status: 200, data: method === 'GET' ? [] : null, next: null }) };
    const recorded: string[] = [];
    await executeLive([d], { client: client as never, repo: REPO, log: () => {}, runUrl: null, isNew: () => true, validate: () => {}, record: async (ev) => void recorded.push(`${ev.type}/${String(ev.fields.reason ?? ev.fields.effect)}`) });
    assert.deepEqual(calls.filter((c) => c.method === 'POST').map((c) => c.path), [
      `/repos/${REPO}/issues/21/labels`,
      `/repos/${REPO}/issues/3/labels`,
      `/repos/${REPO}/issues/21/comments`,
    ]);
    assert.ok(!calls.some((c) => c.path.includes('/dispatches')));
    assert.deepEqual(recorded, ['needs_human/repair_unavailable', 'handoff_done/label:needs-human'], 'recorded before the effect, completed after');
  });
});

describe('write allowlist by mode', () => {
  const sha = 'a'.repeat(40);
  const dispatch = (inputs: Record<string, unknown>, ref = 'main', wf = 'implement.lock.yml') => ['POST', `/repos/${REPO}/actions/workflows/${wf}/dispatches`, { ref, inputs }] as const;
  const good = { task: 'en/time-unit-ago-format-parser', issue: '45', attempt: '1', contract_sha: sha };
  const allowed = (mode: 'live' | 'dry-run', [m, p, b]: readonly [string, string, unknown]) => {
    try {
      assertAllowedRequest(REPO, m as 'POST', p, b, mode);
      return true;
    } catch {
      return false;
    }
  };

  it('dry-run refuses every live write', () => {
    for (const w of [dispatch(good), ['POST', `/repos/${REPO}/issues/45/labels`, { labels: ['factory:picked'] }], ['POST', `/repos/${REPO}/issues/45/comments`, { body: `${COMMENT_MARKER} x` }]] as const) {
      assert.equal(allowed('dry-run', w), false, w[1]);
      assert.equal(allowed('live', w), true, w[1]);
    }
  });

  it('live allows only implement on main, with exactly the four validated inputs', () => {
    assert.equal(allowed('live', dispatch(good, 'dev')), false);
    assert.equal(allowed('live', dispatch(good, 'main', 'pages.yml')), false);
    assert.equal(allowed('live', dispatch({ ...good, aw_context: '{}' })), false, 'no extra inputs (aw_context)');
    assert.equal(allowed('live', dispatch({ ...good, contract_sha: sha.slice(0, 7) })), false, 'full SHA only');
    assert.equal(allowed('live', dispatch({ ...good, task: '../x' })), false);
    assert.equal(allowed('live', dispatch({ ...good, issue: 45 })), false, 'inputs are strings');
    assert.equal(allowed('live', dispatch({ ...good, issue: '0' })), false);
  });

  it('live adds only the controller labels (factory:ready only via auto-ready), and comments only from the template', () => {
    const labels = (l: unknown) => ['POST', `/repos/${REPO}/issues/45/labels`, { labels: l }] as const;
    for (const l of ['factory:picked', 'factory:ready', 'needs-human', 'blocked', 'stale-contract']) assert.equal(allowed('live', labels([l])), true, l);
    for (const l of [['tier:auto'], ['factory:task'], [], ['needs-human', 'tier:auto'], ['factory:ready', 'factory:picked'], ['needs-human', 'factory:ready'], 'needs-human']) assert.equal(allowed('live', labels(l)), false, JSON.stringify(l));
    assert.equal(allowed('live', ['POST', `/repos/${REPO}/issues/45/comments`, { body: 'hello' }]), false);
    assert.equal(allowed('live', ['POST', `/repos/${REPO}/issues/45/comments`, { body: `${COMMENT_MARKER} ${'x'.repeat(2000)}` }]), false);
    assert.equal(allowed('live', ['POST', `/repos/other/repo/issues/45/comments`, { body: `${COMMENT_MARKER} x` }]), false);
  });

  it('live allows closing an issue as completed and removing factory:ready/factory:picked, nothing more', () => {
    assert.equal(allowed('live', ['PATCH', `/repos/${REPO}/issues/45`, { state: 'closed', state_reason: 'completed' }]), true);
    for (const l of ['factory%3Aready', 'factory%3Apicked']) assert.equal(allowed('live', ['DELETE', `/repos/${REPO}/issues/45/labels/${l}`, undefined]), true, l);
    assert.equal(allowed('dry-run', ['PATCH', `/repos/${REPO}/issues/45`, { state: 'closed', state_reason: 'completed' }]), false);
    assert.equal(allowed('dry-run', ['DELETE', `/repos/${REPO}/issues/45/labels/factory%3Apicked`, undefined]), false);
  });

  it('live still refuses merges, other closes and issue edits, other label removal, reviews and other writes', () => {
    const refused = [
      ['PUT', `/repos/${REPO}/pulls/21/merge`, {}],
      ['PATCH', `/repos/${REPO}/issues/45`, { state: 'closed' }],
      ['PATCH', `/repos/${REPO}/issues/45`, { state: 'closed', state_reason: 'not_planned' }],
      ['PATCH', `/repos/${REPO}/issues/45`, { state: 'closed', state_reason: 'completed', title: 'x' }],
      ['PATCH', `/repos/${REPO}/issues/45`, { state: 'open', state_reason: 'completed' }],
      ['PATCH', `/repos/${REPO}/pulls/45`, { state: 'closed', state_reason: 'completed' }],
      ['DELETE', `/repos/${REPO}/issues/45/labels/needs-human`, undefined],
      ['DELETE', `/repos/${REPO}/issues/45/labels/factory:ready`, undefined],
      ['DELETE', `/repos/${REPO}/issues/45/labels`, undefined],
      ['DELETE', `/repos/other/repo/issues/45/labels/factory%3Aready`, undefined],
      ['PUT', `/repos/${REPO}/issues/45/labels`, { labels: ['needs-human'] }],
      ['POST', `/repos/${REPO}/pulls/21/reviews`, { event: 'APPROVE' }],
      ['POST', `/repos/${REPO}/issues`, { title: 'x' }],
      ['PATCH', `/repos/${REPO}/git/refs/heads/main`, { sha, force: false }],
      ['POST', '/graphql', { query: 'mutation { x }' }],
    ] as const;
    for (const w of refused) assert.equal(allowed('live', w), false, `${w[0]} ${w[1]}`);
  });
});

describe('live mode: review fixes', () => {
  it('a decision recorded while the switch was off still gets its live effect after switching on', async () => {
    const gh = liveWorld();
    await seedSpendSnapshot(gh, '2026-10-16T00:05:00Z');
    const off = await run(deps(gh, { env: { ...LIVE_ENV, FACTORY_ENABLED: undefined }, forceDryRun: false }));
    assert.equal(off.live, false);
    assert.ok(off.appended.some((e) => e.type === 'needs_human' && e.payload.reason === 'gates_failed' && e.payload.dry_run === true));
    assert.deepEqual(effectCalls(gh), []);
    gh.calls.length = 0;
    const on = await run(deps(gh, { env: LIVE_ENV, forceDryRun: false, now: new Date(NOW.getTime() + 5 * 60_000) }));
    assert.ok(on.appended.some((e) => e.type === 'needs_human' && e.payload.reason === 'gates_failed' && e.payload.dry_run === false));
    assert.ok(effectCalls(gh).some((c) => c.path === `/repos/${REPO}/issues/11/labels`));
    assert.equal(gh.comments.get(11)?.length, 1);
  });

  it('a hand-off whose comment failed is finished by the next live run, with exactly one comment', async () => {
    const gh = liveWorld(204, 1);
    await seedSpendSnapshot(gh, '2026-10-16T00:05:00Z');
    await assert.rejects(run(deps(gh, { env: LIVE_ENV, forceDryRun: false })), /comments: HTTP 502/);
    assert.equal(gh.comments.get(11)?.length ?? 0, 0);
    const later = (min: number) => new Date(NOW.getTime() + min * 60_000);
    const second = await run(deps(gh, { env: LIVE_ENV, forceDryRun: false, now: later(5) }));
    assert.equal(gh.comments.get(11)?.length, 1);
    assert.match(gh.comments.get(11)![0]!, /<!-- factory-decision: sha256:[0-9a-f]{64} -->/);
    assert.ok(second.appended.some((e) => e.type === 'handoff_done'));
    gh.calls.length = 0;
    await run(deps(gh, { env: LIVE_ENV, forceDryRun: false, now: later(10) }));
    assert.deepEqual(effectCalls(gh), [], 'nothing left to do');
    assert.equal(gh.comments.get(11)?.length, 1);
  });

  it('a hand-off whose comment was posted but not marked done is completed without a second comment', async () => {
    const gh = liveWorld();
    await seedSpendSnapshot(gh, '2026-10-16T00:05:00Z');
    await run(deps(gh, { env: LIVE_ENV, forceDryRun: false }));
    assert.equal(gh.comments.get(11)?.length, 1);
    // Simulate a lost handoff_done: finish the pending list again by hand.
    const events = [...splitLines(gh.fileAt(AUDIT_BRANCH, 'audit/2026/10/16.jsonl')!)].map((l) => JSON.parse(l)).filter((e) => e.type !== 'handoff_done');
    const pending = pendingHandoffs(events);
    assert.equal(pending.length, 1);
    const client = { request: (m: 'GET' | 'POST', p: string, o?: { body?: unknown }) => gh.request(m, p, o) };
    await executeLive([], { client, repo: REPO, log: () => {}, runUrl: null, isNew: () => true, validate: () => {}, record: async () => {}, pending });
    assert.equal(gh.comments.get(11)?.length, 1, 'the marker prevents a duplicate comment');
  });
});

describe('live mode: what the run reports', () => {
  it('a repair candidate is reported and recorded as the hand-off that actually happened', async () => {
    const c = contract('en/weekday-parser');
    const pr = pull(21, { task_id: 'en/weekday-parser', contract_sha: c.last_commit_sha });
    const s = snapshot({
      issues: [issue(1, 'en/weekday-parser', ['factory:picked'])],
      pulls: [pr],
      contractList: [c],
      check_runs: [
        checkRun(490, { workflow: 'gates', event: 'pull_request_target', head_sha: hex40('e'), candidate_sha: pr.head_sha, conclusion: 'success' }),
        checkRun(500, { head_sha: pr.head_sha, pull_requests: [21], conclusion: 'failure', failure_signature: 'step:golden', heldout_seed: '7' }),
      ],
      history: { 'en/weekday-parser': history({ picked_at: '2026-10-16T10:00:00Z' }) },
    });
    const gh = liveWorld();
    const result = await run(deps(gh, { env: LIVE_ENV, forceDryRun: false, snapshot: s }));
    assert.equal(result.live, true);
    assert.ok(!result.decisions.some((d) => d.type === 'repair_dispatched' || d.effect === 'dispatch_workflow:repair'));
    const d = result.decisions.find((x) => x.reason === 'repair_unavailable')!;
    assert.deepEqual([d.type, d.effect], ['needs_human', 'label:needs-human']);
    assert.match(result.summary, /\| needs_human \| repair_unavailable \| label:needs-human \|/);
    assert.doesNotMatch(result.summary, /dispatch_workflow:repair/);
    const ev = result.appended.find((e) => e.payload.reason === 'repair_unavailable')!;
    assert.deepEqual([ev.type, ev.payload.effect, ev.payload.dry_run], ['needs_human', 'label:needs-human', false]);
  });
});

describe('spend collector in the run', () => {
  it('records a real spend_snapshot (dry_run: false, with sources) before planning, even in dry-run, and only when it changes', async () => {
    const gh = fakeWorld();
    const r = `/repos/${REPO}`;
    gh.routes.unshift(
      { method: 'GET', path: new RegExp(`^${r}/actions/workflows/implement\\.lock\\.yml/runs$`), handler: () => ({ data: { workflow_runs: [{ id: 901, run_attempt: 1, status: 'in_progress', created_at: '2026-10-16T09:00:00Z' }] } }) },
    );
    const lines: string[] = [];
    const first = await run(deps(gh, { log: (l) => lines.push(l) }));
    assert.equal(first.live, false);
    assert.ok(lines.includes('spend today: 900 AIC from 1 implement run(s)'));
    const snap = first.appended.find((e) => e.type === 'spend_snapshot')!;
    assert.equal(snap.payload.dry_run, false);
    assert.deepEqual([snap.payload.day, snap.payload.aic_today, snap.payload.runs], ['2026-10-16', 900, [{ run_id: 901, status: 'reserved', aic: 900 }]]);
    assert.ok(first.appended.indexOf(snap) < first.appended.findIndex((e) => e.type === 'dispatched'), 'measured before the decisions are recorded');
    assert.equal(first.snapshot.factory_aic_today, 900);
    assert.match(first.summary, /Spend today: 900 AIC from 1 implement run\(s\)/);
    const second = await run(deps(gh, { now: new Date(NOW.getTime() + 5 * 60_000) }));
    assert.ok(!second.appended.some((e) => e.type === 'spend_snapshot'), 'unchanged spend is not recorded again');
  });

  it('reserved spend counts against the daily budget (pause when reservations reach it)', async () => {
    const gh = fakeWorld();
    const r = `/repos/${REPO}`;
    const runs = Array.from({ length: 12 }, (_, i) => ({ id: 910 + i, run_attempt: 1, status: 'queued', created_at: '2026-10-16T09:00:00Z' }));
    gh.routes.unshift({ method: 'GET', path: new RegExp(`^${r}/actions/workflows/implement\\.lock\\.yml/runs$`), handler: () => ({ data: { workflow_runs: runs } }) });
    const result = await run(deps(gh));
    assert.equal(result.snapshot.factory_aic_today, 10800);
    assert.ok(result.decisions.some((d) => d.type === 'budget_pause'));
    assert.ok(!result.decisions.some((d) => d.type === 'dispatched'));
  });
});

describe('merge stage in the run (live)', () => {
  /** An eligible green auto-tier agent PR (#21) for en/weekday-parser, issue #1 picked. */
  function greenSnapshot(over: Partial<ReturnType<typeof pull>> = {}) {
    const c = contract('en/weekday-parser');
    const pr = pull(21, { task_id: 'en/weekday-parser', contract_sha: c.last_commit_sha, mergeable: 'MERGEABLE', in_merge_queue: false, ...over });
    return snapshot({
      issues: [issue(1, 'en/weekday-parser', ['factory:ready', 'factory:picked'])],
      pulls: [pr],
      contractList: [c],
      check_runs: [
        checkRun(490, { workflow: 'gates', event: 'pull_request_target', head_sha: hex40('e'), candidate_sha: pr.head_sha, conclusion: 'success' }),
        checkRun(500, { head_sha: pr.head_sha, pull_requests: [21], conclusion: 'success', heldout_seed: '7' }),
      ],
      history: { 'en/weekday-parser': history({ picked_at: '2026-10-16T10:00:00Z' }) },
    });
  }
  /** liveWorld + a GraphQL route for the enqueue mutation (`reply` decides the response). */
  function mergeWorld(reply: () => { status?: number; data: unknown } = () => ({ data: { data: { enqueuePullRequest: { mergeQueueEntry: { id: 'MQE_1' } } } } }), currentHead = hex40('1')) {
    const gh = liveWorld();
    const calls: unknown[] = [];
    gh.routes.unshift(
      { method: 'POST', path: /^\/graphql$/, handler: (_p, body) => (calls.push(body), reply()) },
      { method: 'GET', path: new RegExp(`^/repos/${REPO}/pulls/21$`), handler: () => ({ data: { number: 21, head: { sha: currentHead } } }) },
    );
    return { gh, calls };
  }

  it('enqueues with the exact mutation and the PR node id, then records auto_merge (dry_run: false)', async () => {
    const { gh, calls } = mergeWorld();
    const result = await run(deps(gh, { env: LIVE_ENV, forceDryRun: false, snapshot: greenSnapshot() }));
    assert.deepEqual(calls, [{ query: ENQUEUE_MUTATION, variables: { id: 'PR_21', head: hex40('1') } }]);
    for (const c of gh.calls) assert.doesNotThrow(() => assertAllowedRequest(REPO, c.method, c.path, c.body, 'live'), `${c.method} ${c.path}`);
    const ev = result.appended.find((e) => e.type === 'auto_merge')!;
    assert.deepEqual([ev.payload.reason, ev.payload.effect, ev.payload.pr, ev.payload.head_sha, ev.payload.dry_run], ['auto_merge_ready', 'enqueue_merge', 21, hex40('1'), false]);
    assert.ok(!effectCalls(gh).some((c) => /\/merge$|\/labels$|\/comments$/.test(c.path)), 'no direct merge, no labels, no comments');
  });

  it('a second run does not enqueue again (live dedupe on the PR and head)', async () => {
    const { gh, calls } = mergeWorld();
    await run(deps(gh, { env: LIVE_ENV, forceDryRun: false, snapshot: greenSnapshot() }));
    await run(deps(gh, { env: LIVE_ENV, forceDryRun: false, snapshot: greenSnapshot(), now: new Date(NOW.getTime() + 5 * 60_000) }));
    assert.equal(calls.length, 1);
  });

  it('dry-run and the kill switch never enqueue', async () => {
    for (const env of [{ ...LIVE_ENV, FACTORY_ENABLED: undefined }, { ...LIVE_ENV, FACTORY_ENABLED: 'false' }]) {
      const { gh, calls } = mergeWorld();
      const result = await run(deps(gh, { env, forceDryRun: false, snapshot: greenSnapshot() }));
      assert.equal(result.live, false);
      assert.deepEqual(calls, []);
    }
    // Dry-run with the planner seeing FACTORY_ENABLED=true: the plan is logged and recorded as dry-run only.
    const { gh, calls } = mergeWorld();
    const lines: string[] = [];
    const result = await run(deps(gh, { snapshot: greenSnapshot(), log: (l) => lines.push(l) }));
    assert.deepEqual(calls, []);
    assert.ok(lines.some((l) => l.startsWith('[dry-run] would enqueue_merge (auto_merge/auto_merge_ready) task=en/weekday-parser issue=#1 pr=#21')));
    assert.equal(result.appended.find((e) => e.type === 'auto_merge')!.payload.dry_run, true);
  });

  it('GitHub refusing the enqueue (GraphQL error or HTTP 4xx) becomes needs_human/enqueue_failed: label + one comment', async () => {
    for (const reply of [() => ({ data: { errors: [{ message: 'Pull request is not mergeable' }] } }), () => ({ status: 403, data: null })]) {
      const { gh } = mergeWorld(reply);
      const result = await run(deps(gh, { env: LIVE_ENV, forceDryRun: false, snapshot: greenSnapshot() }));
      assert.ok(result.appended.some((e) => e.type === 'needs_human' && e.payload.reason === 'enqueue_failed' && e.payload.dry_run === false));
      assert.ok(!result.appended.some((e) => e.type === 'auto_merge'), 'not recorded as enqueued');
      assert.deepEqual(effectCalls(gh).find((c) => c.path === `/repos/${REPO}/issues/21/labels`)?.body, { labels: ['needs-human'] });
      assert.equal(gh.comments.get(21)?.length, 1);
      assert.match(gh.comments.get(21)![0]!, /`needs_human` \(`enqueue_failed`\)/);
    }
  });

  it('the head moved between planning and enqueue: GitHub refuses, the plan is stale, nothing is recorded or labelled', async () => {
    const { gh, calls } = mergeWorld(() => ({ data: { errors: [{ message: 'head changed' }] } }), hex40('9'));
    const lines: string[] = [];
    const result = await run(deps(gh, { env: LIVE_ENV, forceDryRun: false, snapshot: greenSnapshot(), log: (l) => lines.push(l) }));
    assert.equal(calls.length, 1);
    assert.ok(lines.some((l) => l.includes('head moved') && l.includes('stale plan')));
    assert.ok(!result.appended.some((e) => e.type === 'auto_merge' || e.payload.reason === 'enqueue_failed'));
    assert.deepEqual(effectCalls(gh).filter((c) => /labels|comments/.test(c.path)), []);
  });

  it('a refusal whose hand-off failed halfway is never retried: the next run finishes the hand-off and does not call GitHub again', async () => {
    const { gh, calls } = mergeWorld(() => ({ data: { errors: [{ message: 'not mergeable' }] } }));
    let labelFailures = 1;
    gh.routes.unshift({ method: 'POST', path: new RegExp(`^/repos/${REPO}/issues/\\d+/labels$`), handler: () => (labelFailures-- > 0 ? { status: 502, data: null } : { data: [] }) });
    await assert.rejects(run(deps(gh, { env: LIVE_ENV, forceDryRun: false, snapshot: greenSnapshot() })), /labels: HTTP 502/);
    assert.equal(calls.length, 1);
    const second = await run(deps(gh, { env: LIVE_ENV, forceDryRun: false, snapshot: greenSnapshot(), now: new Date(NOW.getTime() + 5 * 60_000) }));
    assert.equal(calls.length, 1, 'the enqueue is not attempted again');
    assert.equal(gh.comments.get(21)?.length, 1, 'the pending hand-off was finished');
    assert.ok(second.appended.some((e) => e.type === 'handoff_done'));
  });

  it('a transient enqueue failure (HTTP 5xx) fails the run and records nothing, so the next run retries', async () => {
    const { gh } = mergeWorld(() => ({ status: 502, data: null }));
    await assert.rejects(run(deps(gh, { env: LIVE_ENV, forceDryRun: false, snapshot: greenSnapshot() })), /graphql: HTTP 502/);
    assert.ok(!(gh.fileAt(AUDIT_BRANCH, 'audit/2026/10/16.jsonl') ?? '').includes('"type":"auto_merge"'));
  });

  it('records queued and merged as observed facts', async () => {
    const { gh } = mergeWorld();
    const s = greenSnapshot({
      in_merge_queue: false,
      state: 'merged',
      merged_at: '2026-10-16T11:40:00Z',
      merge_commit_sha: hex40('f'),
      merge_queue_events: [
        { node_id: 'AMQ_9', kind: 'queued', created_at: '2026-10-16T11:30:00Z', actor: 'sabbasi3-factory-controller' },
        { node_id: 'RMQ_9', kind: 'dequeued', created_at: '2026-10-16T11:39:59Z', actor: 'github-merge-queue' },
      ],
    });
    const result = await run(deps(gh, { env: LIVE_ENV, forceDryRun: false, snapshot: s }));
    const types = result.appended.map((e) => e.type);
    assert.ok(types.includes('queued') && types.includes('merged') && types.includes('task_done'), types.join(','));
    assert.ok(!result.decisions.some((d) => d.type === 'auto_merge'), 'a merged PR is not queued again');
  });
});

describe('write allowlist: the enqueue mutation', () => {
  const ok = (body: unknown, mode: 'live' | 'dry-run' = 'live') => {
    try {
      assertAllowedRequest(REPO, 'POST', '/graphql', body, mode);
      return true;
    } catch {
      return false;
    }
  };
  it('live allows exactly ENQUEUE_MUTATION with one PR node id; everything else is refused', () => {
    const H = hex40('1');
    assert.equal(ok({ query: ENQUEUE_MUTATION, variables: { id: 'PR_kwDOabc_-1', head: H } }), true);
    assert.equal(ok({ query: ENQUEUE_MUTATION, variables: { id: 'PR_kwDOabc', head: H } }, 'dry-run'), false);
    assert.equal(ok({ query: ENQUEUE_MUTATION, variables: { id: 'PR_1' } }), false, 'the expected head is required');
    assert.equal(ok({ query: ENQUEUE_MUTATION, variables: { id: 'PR_1', head: H.slice(0, 7) } }), false, 'full head SHA');
    assert.equal(ok({ query: ENQUEUE_MUTATION, variables: { id: 'I_123', head: H } }), false, 'not a PR id');
    assert.equal(ok({ query: ENQUEUE_MUTATION, variables: { id: 'PR_1', head: H, jump: true } }), false);
    assert.equal(ok({ query: ENQUEUE_MUTATION.replace('expectedHeadOid: $head}', 'expectedHeadOid: $head, jump: true}'), variables: { id: 'PR_1', head: H } }), false, 'no jumping the queue');
    assert.equal(ok({ query: 'mutation($id: ID!) { mergePullRequest(input: {pullRequestId: $id}) { clientMutationId } }', variables: { id: 'PR_1', head: H } }), false);
    assert.equal(ok({ query: 'mutation($id: ID!) { dequeuePullRequest(input: {id: $id}) { clientMutationId } }', variables: { id: 'PR_1', head: H } }), false);
    assert.equal(ok({ query: ENQUEUE_MUTATION, variables: { id: 'PR_1', head: H }, operationName: 'x' }), false);
  });
});

describe('task done in the run (live)', () => {
  const T = 'en/time-unit-ago-format-parser';
  /** The #45 situation: #54 merged, issue still open with factory:ready and factory:picked. */
  const doneSnapshot = () =>
    snapshot({ issues: [issue(45, T, ['factory:task', 'factory:ready', 'factory:picked'])], pulls: [mergedPull(54, T)], contractList: [contract(T)] });
  const closeCalls = (gh: FakeGitHub) => gh.calls.filter((c) => c.method === 'DELETE' || c.method === 'PATCH').filter((c) => !c.path.includes('/git/')).map((c) => `${c.method} ${c.path}`);

  it('records task_done (dry_run: false), then removes factory:ready and factory:picked, then closes the issue as completed', async () => {
    const gh = liveWorld();
    const result = await run(deps(gh, { env: LIVE_ENV, forceDryRun: false, snapshot: doneSnapshot() }));
    const ev = result.appended.find((e) => e.type === 'task_done')!;
    assert.deepEqual([ev.payload.reason, ev.payload.effect, ev.payload.task, ev.payload.issue, ev.payload.pr, ev.payload.dry_run], ['task_merged', 'close_task', T, 45, 54, false]);
    assert.deepEqual(closeCalls(gh), [
      `DELETE /repos/${REPO}/issues/45/labels/factory%3Aready`,
      `DELETE /repos/${REPO}/issues/45/labels/factory%3Apicked`,
      `PATCH /repos/${REPO}/issues/45`,
    ]);
    assert.deepEqual(gh.calls.find((c) => c.method === 'PATCH' && c.path.endsWith('/issues/45'))!.body, { state: 'closed', state_reason: 'completed' });
    assert.deepEqual(gh.closed, [45]);
    for (const c of gh.calls) assert.doesNotThrow(() => assertAllowedRequest(REPO, c.method, c.path, c.body, 'live'), `${c.method} ${c.path}`);
    assert.ok(!effectCalls(gh).some((c) => /\/labels$|\/comments$/.test(c.path)), 'no labels added, no comments');
  });

  it('a label that is already gone (404) is fine', async () => {
    const gh = liveWorld();
    gh.routes.unshift({ method: 'DELETE', path: /\/labels\/factory%3Aready$/, handler: () => ({ status: 404, data: null }) });
    await run(deps(gh, { env: LIVE_ENV, forceDryRun: false, snapshot: doneSnapshot() }));
    assert.deepEqual(gh.closed, [45]);
  });

  it('an interrupted close (HTTP 502) fails the run; the next run finishes it without recording task_done twice', async () => {
    const gh = liveWorld();
    gh.failClose = 1;
    await assert.rejects(run(deps(gh, { env: LIVE_ENV, forceDryRun: false, snapshot: doneSnapshot() })), /HTTP 502/);
    assert.deepEqual(gh.closed, []);
    const second = await run(deps(gh, { env: LIVE_ENV, forceDryRun: false, snapshot: doneSnapshot(), now: new Date(NOW.getTime() + 5 * 60_000) }));
    assert.deepEqual(gh.closed, [45]);
    assert.ok(!second.appended.some((e) => e.type === 'task_done'), 'recorded once, by the first run');
    const file = gh.fileAt(AUDIT_BRANCH, 'audit/2026/10/16.jsonl') ?? '';
    assert.equal(file.split('"type":"task_done"').length - 1, 1);
  });

  it('dry-run and the kill switch never close or remove labels', async () => {
    for (const env of [{ ...LIVE_ENV, FACTORY_ENABLED: undefined }, { ...LIVE_ENV, FACTORY_ENABLED: 'TRUE' }]) {
      const gh = liveWorld();
      const result = await run(deps(gh, { env, forceDryRun: false, snapshot: doneSnapshot() }));
      assert.equal(result.live, false);
      assert.deepEqual(closeCalls(gh), []);
    }
    const gh = liveWorld();
    const lines: string[] = [];
    const result = await run(deps(gh, { snapshot: doneSnapshot(), log: (l) => lines.push(l) }));
    assert.deepEqual(closeCalls(gh), []);
    assert.ok(lines.some((l) => l.startsWith('[dry-run] would close_task (task_done/task_merged) task=en/time-unit-ago-format-parser issue=#45 pr=#54')));
    assert.equal(result.appended.find((e) => e.type === 'task_done')!.payload.dry_run, true);
  });
});

describe('Project status sync in the run', () => {
  it('live: after the effects, sets each item whose status differs (exact mutation), and reports it', async () => {
    const gh = liveWorld();
    await seedSpendSnapshot(gh, '2026-10-16T00:05:00Z');
    gh.project = projectNode([
      { item: 'PVTI_10', issue: 10, status: 'Proposed', labels: ['factory:ready'] },
      { item: 'PVTI_12', issue: 12, status: 'Ready', labels: ['factory:ready'], task: 'en/other' },
    ]);
    const result = await run(deps(gh, { env: LIVE_ENV, forceDryRun: false }));
    assert.deepEqual(gh.statusUpdates, [{ project: 'PVT_1', item: 'PVTI_10', field: 'PVTSSF_1', option: '00000001' }]);
    assert.match(result.summary, /Project status: 1 update\(s\)/);
    for (const c of gh.calls) assert.doesNotThrow(() => assertAllowedRequest(REPO, c.method, c.path, c.body, 'live'), `${c.method} ${c.path}`);
  });

  it('dry-run only logs; an unreadable Project never fails the run (heartbeat still written)', async () => {
    const gh = liveWorld();
    gh.project = projectNode([{ item: 'PVTI_10', issue: 10, status: 'Proposed', labels: ['factory:ready'] }]);
    const lines: string[] = [];
    await run(deps(gh, { log: (l) => lines.push(l) }));
    assert.deepEqual(gh.statusUpdates, []);
    assert.ok(lines.includes('[dry-run] would set Factory status #10 en/casual-date: Proposed → Ready'));
    const broken = liveWorld();
    broken.project = null;
    const result = await run(deps(broken, { env: LIVE_ENV, forceDryRun: false }));
    assert.match(result.summary, /Project status: stopped after 0 update\(s\): project 1 not found/);
    assert.ok(result.appended.some((e) => e.type === 'heartbeat'));
  });
});

describe('reviewer agent in the run (live)', () => {
  const T = 'core/results';
  const strict: typeof policies = structuredClone(policies);
  delete (strict.tiers.tiers['auto-strict'] as { start_as?: string }).start_as;
  const reviewSnapshot = () => {
    const c = contract(T, { tier: 'auto-strict', scope: ['src/core/results.rs'] });
    const pr = pull(21, { task_id: T, contract_sha: c.last_commit_sha, mergeable: 'MERGEABLE', in_merge_queue: false });
    return snapshot({
      issues: [issue(1, T, ['factory:ready', 'factory:picked'])],
      pulls: [pr],
      contractList: [c],
      check_runs: [
        checkRun(490, { workflow: 'gates', event: 'pull_request_target', head_sha: hex40('e'), candidate_sha: pr.head_sha, conclusion: 'success' }),
        checkRun(500, { head_sha: pr.head_sha, pull_requests: [21], conclusion: 'success' }),
      ],
      history: { [T]: history({ picked_at: '2026-10-16T10:00:00Z' }) },
    });
  };
  const DISPATCH = `/repos/${REPO}/actions/workflows/review.lock.yml/dispatches`;

  it('records review_dispatched (with the head) first, then dispatches review.lock.yml on main with exactly the four inputs', async () => {
    const gh = liveWorld();
    gh.addRoute('POST', new RegExp(`^${DISPATCH}$`), () => ({ status: 204, data: null }));
    const result = await run(deps(gh, { env: LIVE_ENV, forceDryRun: false, policies: strict, snapshot: reviewSnapshot() }));
    const ev = result.appended.find((e) => e.type === 'review_dispatched')!;
    assert.deepEqual([ev.payload.reason, ev.payload.effect, ev.payload.pr, ev.payload.head_sha, ev.payload.dry_run], ['review_needed', 'dispatch_workflow:review', 21, hex40('1'), false]);
    const calls = gh.calls.filter((c) => c.method === 'POST' && !c.path.includes('/git/') && c.path !== '/graphql');
    assert.deepEqual(calls.map((c) => [c.path, c.body]), [[DISPATCH, { ref: 'main', inputs: { task: T, pr: '21', head_sha: hex40('1'), contract_sha: commitSha(T) } }]]);
    for (const c of gh.calls) assert.doesNotThrow(() => assertAllowedRequest(REPO, c.method, c.path, c.body, 'live'), `${c.method} ${c.path}`);
    // The next run sees the record (history.reviews) and doesn't ask again.
    gh.calls.length = 0;
    const history2 = deriveState(result.appended, NOW).history[T]!;
    const s2 = { ...reviewSnapshot(), history: { [T]: { ...history2, picked_at: '2026-10-16T10:00:00Z' } } };
    const second = await run(deps(gh, { env: LIVE_ENV, forceDryRun: false, policies: strict, snapshot: s2, now: new Date(NOW.getTime() + 5 * 60_000) }));
    assert.ok(!gh.calls.some((c) => c.path === DISPATCH));
    assert.ok(second.decisions.some((d) => d.reason === 'review_pending'));
  });

  it('a failed dispatch fails the run after the record: never a second review (the timeout hands it to a person)', async () => {
    const gh = liveWorld();
    gh.addRoute('POST', new RegExp(`^${DISPATCH}$`), () => ({ status: 500, data: null }));
    await assert.rejects(run(deps(gh, { env: LIVE_ENV, forceDryRun: false, policies: strict, snapshot: reviewSnapshot() })), /dispatches: HTTP 500/);
    const file = gh.fileAt(AUDIT_BRANCH, 'audit/2026/10/16.jsonl') ?? '';
    assert.ok(file.includes('"type":"review_dispatched"'), 'recorded before the dispatch');
  });

  it('dry-run never dispatches a review', async () => {
    const gh = liveWorld();
    const lines: string[] = [];
    await run(deps(gh, { policies: strict, snapshot: reviewSnapshot(), log: (l) => lines.push(l) }));
    assert.ok(!gh.calls.some((c) => c.path === DISPATCH));
    assert.ok(lines.some((l) => l.startsWith('[dry-run] would dispatch_workflow:review (review_dispatched/review_needed) task=core/results issue=#1 pr=#21')));
  });
});

describe('write allowlist: the review dispatch', () => {
  const sha = hex40('a');
  const good = { task: 'core/results', pr: '21', head_sha: sha, contract_sha: sha };
  const req = (inputs: unknown, ref = 'main', file = 'review.lock.yml') => ['POST', `/repos/${REPO}/actions/workflows/${file}/dispatches`, { ref, inputs }] as const;
  const ok = (r: readonly [string, string, unknown], mode: 'live' | 'dry-run' = 'live') => {
    try {
      assertAllowedRequest(REPO, r[0] as 'POST', r[1], r[2], mode);
      return true;
    } catch {
      return false;
    }
  };
  it('live allows exactly review.lock.yml on main with the four validated string inputs', () => {
    assert.equal(ok(req(good)), true);
    assert.equal(ok(req(good), 'dry-run'), false);
    assert.equal(ok(req(good, 'dev')), false);
    for (const bad of [{ ...good, pr: 21 }, { ...good, pr: '0' }, { ...good, head_sha: sha.slice(0, 7) }, { ...good, contract_sha: 'x' }, { ...good, task: '../x' }, { ...good, aw_context: '{}' }, { task: good.task, pr: good.pr, head_sha: sha }]) {
      assert.equal(ok(req(bad)), false, JSON.stringify(bad));
    }
  });
});

describe('reviewer checks and history', () => {
  const APP = REVIEWER_APP_ID;
  it('readReviewChecks keeps only factory-review check runs from the reviewer App on that exact head, and parses Reviewed-Head', async () => {
    const gh = new FakeGitHub(REPO);
    const head = hex40('1');
    gh.addRoute('GET', new RegExp(`^/repos/${REPO}/commits/${head}/check-runs$`), (path) => {
      assert.match(path, /check_name=factory-review/);
      const base = { name: 'factory-review', head_sha: head, status: 'completed', conclusion: 'success', started_at: '2026-10-16T11:40:00Z', app: { id: APP }, output: { summary: `Reviewed-Head: ${head}\nNo divergence` } };
      return {
        data: {
          check_runs: [
            { id: 1, ...base },
            { id: 2, ...base, app: { id: 15368, slug: 'github-actions' } },
            { id: 3, ...base, name: 'other' },
            { id: 4, ...base, head_sha: hex40('2') },
            { id: 5, ...base, output: { summary: 'Reviewed-Head: nope' } },
          ],
        },
      };
    });
    const checks = await readReviewChecks(gh, REPO, [head, 'not-a-sha'], APP);
    assert.deepEqual(checks.map((c) => [c.id, c.reviewed_head]), [[1, head], [5, null]]);
  });

  it('the accepted reviewer is pinned to the reviewer App id (5444751) in code', () => {
    assert.equal(REVIEWER_APP_ID, 5444751);
  });

  it('history: live review_dispatched events give each task its reviewed heads', () => {
    const at = '2026-10-16T11:30:00Z';
    const ev = (dry: boolean) => ({ version: 1 as const, id: 'x', type: 'review_dispatched', timestamp: at, parents: [], sha: 's', payload: { task: 'core/results', pr: 21, head_sha: hex40('1'), dry_run: dry } });
    assert.deepEqual(deriveState([ev(false)], NOW).history['core/results']!.reviews, [{ pr: 21, head: hex40('1'), contract: null, at }]);
    const withContract = { ...ev(false), payload: { ...ev(false).payload, contract_sha: hex40('c') } };
    assert.deepEqual(deriveState([withContract], NOW).history['core/results']!.reviews, [{ pr: 21, head: hex40('1'), contract: hex40('c'), at }]);
    assert.equal(deriveState([ev(true)], NOW).history['core/results'], undefined, 'dry-run plans are not reviews');
  });
});

describe('auto-ready in the run (live)', () => {
  const T = 'en/next-parser';
  const on: typeof policies = structuredClone(policies);
  on.limits.auto_ready = true;
  const readySnapshot = () => snapshot({ issues: [issue(38, T, ['factory:task', 'tier:auto'])], contractList: [contract(T)] });
  /** liveWorld + the issue as GitHub has it now (read by the executor before labelling). */
  const readyWorld = (issueNow: Record<string, unknown> = { state: 'open', labels: [{ name: 'factory:task' }] }) => {
    const gh = liveWorld();
    gh.addRoute('GET', new RegExp(`^/repos/${REPO}/issues/38$`), () => ({ data: { number: 38, ...issueNow } }));
    return gh;
  };

  it('records auto_ready first, then adds factory:ready to the issue; a retry re-applies the label without recording twice', async () => {
    const gh = readyWorld();
    const result = await run(deps(gh, { env: LIVE_ENV, forceDryRun: false, policies: on, snapshot: readySnapshot() }));
    const ev = result.appended.find((e) => e.type === 'auto_ready')!;
    assert.deepEqual([ev.payload.reason, ev.payload.effect, ev.payload.task, ev.payload.issue, ev.payload.dry_run], ['deps_merged', 'label:ready', T, 38, false]);
    assert.deepEqual(effectCalls(gh).map((c) => [c.path, c.body]), [[`/repos/${REPO}/issues/38/labels`, { labels: ['factory:ready'] }]]);
    for (const c of gh.calls) assert.doesNotThrow(() => assertAllowedRequest(REPO, c.method, c.path, c.body, 'live'), `${c.method} ${c.path}`);
    gh.calls.length = 0;
    const second = await run(deps(gh, { env: LIVE_ENV, forceDryRun: false, policies: on, snapshot: readySnapshot(), now: new Date(NOW.getTime() + 5 * 60_000) }));
    assert.ok(!second.appended.some((e) => e.type === 'auto_ready'));
    assert.deepEqual(effectCalls(gh).map((c) => c.path), [`/repos/${REPO}/issues/38/labels`]);
  });

  it('the executor re-reads the issue: closed, a PR, or not a factory task → recorded but never labelled', async () => {
    for (const now of [{ state: 'closed', labels: [{ name: 'factory:task' }] }, { state: 'open', labels: [] }, { state: 'open', labels: [{ name: 'factory:task' }], pull_request: {} }]) {
      const gh = readyWorld(now);
      await run(deps(gh, { env: LIVE_ENV, forceDryRun: false, policies: on, snapshot: readySnapshot() }));
      assert.ok(!effectCalls(gh).some((c) => c.path.endsWith('/labels')), JSON.stringify(now));
    }
  });

  it('switched off (the default), or dry-run: nothing is labelled', async () => {
    const off = liveWorld();
    await run(deps(off, { env: LIVE_ENV, forceDryRun: false, snapshot: readySnapshot() }));
    assert.deepEqual(effectCalls(off), []);
    const dry = liveWorld();
    const lines: string[] = [];
    await run(deps(dry, { policies: on, snapshot: readySnapshot(), log: (l) => lines.push(l) }));
    assert.deepEqual(effectCalls(dry), []);
    assert.ok(lines.some((l) => l.startsWith('[dry-run] would label:ready (auto_ready/deps_merged) task=en/next-parser issue=#38')));
  });
});
