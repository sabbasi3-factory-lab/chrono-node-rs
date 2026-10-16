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
import { NOW, REPO, testPolicies } from './helpers.ts';
import { fakeWorld } from './world.ts';

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
    const result = await run(deps(gh));
    const file = gh.fileAt(AUDIT_BRANCH, 'audit/2026/10/16.jsonl')!;
    const ls = splitLines(file);
    assert.equal(ls.length, result.appended.length);
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
    const result = await run(deps(fakeWorld()));
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
  return { repo: REPO, fetched_at: '2026-10-16T12:00:00Z', issues: [], pulls: [], contracts: {}, check_runs: [], busy_jobs: null, factory_aic_today: null, history: {} };
}
