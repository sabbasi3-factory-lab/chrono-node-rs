import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  assertAllowedRequest,
  createClient,
  GitHubApiError,
  MAX_HEAD_LOOKUPS,
  leavesGithubDirAlone,
  mapPull,
  nextPathFromLink,
  paginate,
  failureSignatureFromSteps,
  HELDOUT_COMMIT_STEP,
  parseHeldoutSeed,
  trustedCommitStepRan,
  readBusyJobs,
  readCheckRuns,
  readChecksJobLog,
  RECENT_RUN_PAGES,
  readSnapshot,
  uncheckedHeads,
  FULL_REGRESSION_STEP,
  stepConclusion,
} from '../github.ts';
import { FakeGitHub } from '../fake.ts';
import type { RecordedCheck } from '../github.ts';
import { hex40, NOW, REPO } from './helpers.ts';
import { CONTRACT_COMMIT, fakeWorld, MAIN_SHA, MAIN_TREE } from './world.ts';

describe('write guard', () => {
  const ok = (m: Parameters<typeof assertAllowedRequest>[1], p: string, b?: unknown) => assert.doesNotThrow(() => assertAllowedRequest(REPO, m, p, b));
  const no = (m: Parameters<typeof assertAllowedRequest>[1], p: string, b?: unknown) => assert.throws(() => assertAllowedRequest(REPO, m, p, b), /refusing/);

  it('allows reads and the audit-branch Git Data writes', () => {
    ok('GET', `/repos/${REPO}/issues?state=open`);
    ok('POST', `/repos/${REPO}/git/blobs`, { content: 'x' });
    ok('POST', `/repos/${REPO}/git/trees`, {});
    ok('POST', `/repos/${REPO}/git/commits`, {});
    ok('PATCH', `/repos/${REPO}/git/refs/heads/audit`, { sha: 'x', force: false });
    ok('POST', `/repos/${REPO}/git/refs`, { ref: 'refs/heads/audit', sha: 'x' });
    ok('POST', '/graphql', { query: 'query { viewer { login } }' });
  });

  it('refuses every other mutation', () => {
    no('PATCH', `/repos/${REPO}/git/refs/heads/main`, { sha: 'x', force: false });
    no('PATCH', `/repos/${REPO}/git/refs/heads/audit`, { sha: 'x', force: true });
    no('PATCH', `/repos/${REPO}/git/refs/heads/audit`, { sha: 'x' });
    no('POST', `/repos/${REPO}/git/refs`, { ref: 'refs/heads/main', sha: 'x' });
    no('DELETE', `/repos/${REPO}/git/refs/heads/audit`);
    no('POST', `/repos/${REPO}/issues/1/labels`, { labels: ['x'] });
    no('POST', `/repos/${REPO}/issues/1/comments`, { body: 'x' });
    no('POST', `/repos/${REPO}/actions/workflows/implement.yml/dispatches`, {});
    no('PUT', `/repos/${REPO}/pulls/1/merge`, {});
    no('POST', `/repos/other/repo/git/blobs`, {});
    no('PUT', `/repos/${REPO}/contents/audit/x.jsonl`, {});
    no('POST', '/graphql', { query: 'mutation { enqueuePullRequest(input: {}) { clientMutationId } }' });
    no('POST', '/graphql', { query: 'query { a } mutation { b }' });
  });
});

describe('client', () => {
  it('sends auth + API version headers and parses JSON + Link pagination', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const client = createClient('t0k3n', REPO, async (url, init) => {
      seen.push({ url, init });
      return new Response(JSON.stringify([1]), {
        status: 200,
        headers: { link: `<https://api.github.com/repositories/1/issues?page=2>; rel="next", <https://api.github.com/repositories/1/issues?page=3>; rel="last"` },
      });
    });
    const res = await client.request('GET', `/repos/${REPO}/issues`);
    assert.deepEqual(res.data, [1]);
    assert.equal(res.next, '/repositories/1/issues?page=2');
    const h = seen[0]!.init.headers as Record<string, string>;
    assert.equal(seen[0]!.url, `https://api.github.com/repos/${REPO}/issues`);
    assert.equal(h.Authorization, 'Bearer t0k3n');
    assert.equal(h['X-GitHub-Api-Version'], '2022-11-28');
    assert.equal(seen[0]!.init.redirect, 'follow');
  });

  it('returns raw text, allowed statuses, and throws other errors without leaking the token', async () => {
    const client = createClient('secret', REPO, async (url) => {
      if (url.endsWith('/logs')) return new Response('factory-heldout-seed: 1\n', { status: 200 });
      if (url.endsWith('/missing')) return new Response('nope', { status: 404 });
      return new Response('boom', { status: 500 });
    });
    assert.equal((await client.request('GET', `/repos/${REPO}/actions/jobs/1/logs`, { accept: 'raw' })).data, 'factory-heldout-seed: 1\n');
    assert.equal((await client.request('GET', '/missing', { allowStatuses: [404] })).status, 404);
    await assert.rejects(client.request('GET', '/x?y=1'), (e: unknown) => e instanceof GitHubApiError && e.status === 500 && !e.message.includes('secret') && !e.message.includes('y=1'));
  });

  it('never calls fetch for a refused request', async () => {
    let called = false;
    const client = createClient('t', REPO, async () => {
      called = true;
      return new Response('{}');
    });
    await assert.rejects(client.request('POST', `/repos/${REPO}/issues/1/labels`, { body: {} }), /refusing/);
    assert.equal(called, false);
  });

  it('rejects pagination links to other hosts', () => {
    assert.throws(() => nextPathFromLink('<https://evil.example/x>; rel="next"'), /outside/);
    assert.equal(nextPathFromLink(null), null);
    assert.equal(nextPathFromLink('<https://api.github.com/x?page=9>; rel="last"'), null);
  });

  it('paginates and stops at the page cap', async () => {
    const gh = new FakeGitHub(REPO);
    gh.addRoute('GET', /^\/p$/, (path) => {
      const page = Number(new URLSearchParams(path.split('?')[1]).get('page') ?? '1');
      return { data: [page], next: page < 3 ? `/p?page=${page + 1}` : null };
    });
    assert.deepEqual(await paginate(gh, '/p', (d) => d as number[]), [1, 2, 3]);
    await assert.rejects(paginate(gh, '/p', (d) => d as number[], 2), /exceeded/);
  });
});

describe('trusted held-out seed (commit–reveal) and failure signature', () => {
  const commitFor = (salt: string, seed: string) => createHash('sha256').update(`${salt}:${seed}`).digest('hex');
  const SALT = '0123456789abcdef0123456789abcdef';
  const SEED = '3141592653';
  const ts = (n: number) => `2026-10-16T11:00:${String(n).padStart(2, '0')}.0000000Z `;
  /** A checks-job log: the trusted first step, then PR steps (with `extra` output), then the reveal. */
  const jobLog = (opts: { commitLines?: string[]; extra?: string[]; reveal?: string[] } = {}) =>
    [
      `${ts(0)}##[group]Run seed=$(od -An -N4 -tu4 /dev/urandom | tr -d ' \\n')`,
      `${ts(0)}\u001b[36;1mecho "factory-heldout-commit: $commit"\u001b[0m`,
      `${ts(0)}##[endgroup]`,
      ...(opts.commitLines ?? [`${ts(1)}factory-heldout-commit: ${commitFor(SALT, SEED)}`]),
      `${ts(2)}##[group]Run actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1`,
      ...(opts.extra ?? []).map((l) => `${ts(3)}${l}`),
      `${ts(4)}##[group]Run node compare/compare.js --seed "$HELDOUT_SEED" --phrases 2000`,
      `${ts(5)}factory-comparison-seed: ${SEED}`,
      `${ts(6)}##[group]Run echo "factory-heldout-seed: $HELDOUT_SEED"`,
      ...(opts.reveal ?? [`${ts(7)}factory-heldout-seed: ${SEED}`, `${ts(7)}factory-heldout-salt: ${SALT}`]),
    ].join('\n');

  it('accepts the revealed seed that matches the first step\'s single commitment', () => {
    assert.equal(parseHeldoutSeed(jobLog()), SEED);
  });

  it('ignores forged reveals from PR code (they do not match the commitment)', () => {
    const forged = ['factory-heldout-seed: 42', `factory-heldout-salt: ${'f'.repeat(32)}`];
    assert.equal(parseHeldoutSeed(jobLog({ extra: forged })), SEED);
  });

  it('fails closed on a commitment printed outside the first step, or on none, or two', () => {
    const fake = `factory-heldout-commit: ${commitFor('a'.repeat(32), '42')}`;
    assert.equal(parseHeldoutSeed(jobLog({ extra: [fake, 'factory-heldout-seed: 42', `factory-heldout-salt: ${'a'.repeat(32)}`] })), null);
    assert.equal(parseHeldoutSeed(jobLog({ commitLines: [] })), null);
    assert.equal(parseHeldoutSeed(jobLog({ commitLines: [`${ts(1)}factory-heldout-commit: ${commitFor(SALT, SEED)}`, `${ts(1)}factory-heldout-commit: ${commitFor(SALT, '7')}`] })), null);
  });

  it('returns null without a matching reveal (wrong salt, missing salt, or no reveal at all)', () => {
    assert.equal(parseHeldoutSeed(jobLog({ reveal: [`factory-heldout-seed: ${SEED}`, `factory-heldout-salt: ${'0'.repeat(32)}`] })), null);
    assert.equal(parseHeldoutSeed(jobLog({ reveal: [`factory-heldout-seed: ${SEED}`] })), null);
    assert.equal(parseHeldoutSeed(jobLog({ reveal: [] })), null);
  });

  it('ignores near-miss lines', () => {
    assert.equal(parseHeldoutSeed(jobLog({ reveal: [`x factory-heldout-seed: ${SEED}`, `factory-heldout-salt: ${SALT}`] })), null);
    assert.equal(parseHeldoutSeed(jobLog({ reveal: [`factory-heldout-seed: 0${SEED}`, `factory-heldout-salt: ${SALT}`] })), null);
    assert.equal(parseHeldoutSeed(jobLog({ reveal: [`factory-heldout-seed: ${SEED}\r`, `factory-heldout-salt: ${SALT}\r`] })), SEED);
  });

  it('checks that the first step is the trusted commitment step and that it succeeded', () => {
    const step = (number: number, name: string, conclusion = 'success') => ({ number, name, conclusion });
    assert.ok(trustedCommitStepRan([step(1, 'Set up job'), step(2, HELDOUT_COMMIT_STEP), step(3, 'Run actions/checkout')]));
    assert.ok(!trustedCommitStepRan([step(1, 'Set up job'), step(2, 'Run actions/checkout'), step(3, HELDOUT_COMMIT_STEP)]));
    assert.ok(!trustedCommitStepRan([step(1, 'Set up job'), step(2, HELDOUT_COMMIT_STEP, 'failure')]));
    assert.ok(!trustedCommitStepRan([]));
  });

  it('derives the failure signature from runner-reported step results only', () => {
    const steps = [
      { number: 1, name: 'Set up job', conclusion: 'success' },
      { number: 7, name: 'Whole-crate golden suite (no regressions)', conclusion: 'failure' },
      { number: 9, name: 'Doc tests', conclusion: 'failure' },
    ];
    assert.equal(failureSignatureFromSteps(steps, 'failure'), 'step:whole-crate-golden-suite-no-regressions');
    assert.equal(failureSignatureFromSteps([...steps].reverse(), 'failure'), 'step:whole-crate-golden-suite-no-regressions');
    assert.equal(failureSignatureFromSteps([{ number: 1, name: 'Set up job', conclusion: 'success' }], 'timed_out'), 'job:timed_out');
    assert.equal(failureSignatureFromSteps(steps, 'success'), null);
    assert.equal(failureSignatureFromSteps(steps, 'cancelled'), null);
    assert.equal(failureSignatureFromSteps(steps, null), null);
  });
});

describe('snapshot reader', () => {
  it('maps a PR without keeping free text', () => {
    const p = mapPull({
      id: 'PR_1', number: 1, state: 'MERGED', isDraft: false, createdAt: 'c', mergedAt: 'm', body: `Hello\nFactory-Task: en/a\nContract-SHA: ${hex40('a')}`,
      headRefOid: hex40('1'), mergeCommit: { oid: hex40('2') }, author: { login: 'helper', __typename: 'Bot' },
      labels: { pageInfo: { hasNextPage: false }, nodes: [{ name: 'x' }] }, reviews: { nodes: [] }, timelineItems: { nodes: [] },
    });
    assert.equal(p.author, 'helper[bot]');
    assert.equal(p.author_is_bot, true);
    assert.equal(p.state, 'merged');
    assert.equal(p.task_id, 'en/a');
    assert.ok(!JSON.stringify(p).includes('Hello'));
  });

  it('lists repair runs before reading PR heads (a repair finishing in between is never paired with the old head)', async () => {
    const gh = fakeWorld();
    gh.addRoute('GET', new RegExp(`^/repos/${REPO}/actions/workflows/repair\\.lock\\.yml/runs$`), () => ({ data: { workflow_runs: [] } }));
    const before = gh.calls.length;
    const s = await readSnapshot(gh, { repo: REPO, now: NOW, windowHours: 24, recordedChecks: new Map(), historyTasks: [], needBusyJobs: false });
    const calls = gh.calls.slice(before).map((c) => c.path);
    const repairAt = calls.findIndex((p) => p.includes('/repair.lock.yml/runs'));
    const firstOther = calls.findIndex((p) => !p.includes('/repair.lock.yml/runs'));
    assert.ok(repairAt === 0 && firstOther > repairAt, calls.join('\n'));
    assert.deepEqual(s.repair_runs, []);
  });

  it('reads issues, PRs, contracts (with last commit SHA), CI runs and seeds', async () => {
    const gh = fakeWorld();
    const s = await readSnapshot(gh, { repo: REPO, now: NOW, windowHours: 24, recordedChecks: new Map(), historyTasks: [], needBusyJobs: true });
    assert.deepEqual(s.issues, [{ number: 10, node_id: 'I_10', labels: ['factory:ready'], task_id: 'en/casual-date', marker_status: 'ok' }]);
    assert.equal(s.pulls[0]!.contract_sha, CONTRACT_COMMIT.slice(0, 7));
    assert.equal(s.pulls[0]!.merge_queue_events[0]!.kind, 'queued');
    assert.deepEqual(Object.keys(s.contracts).sort(), ['contracts/en/casual-date.yaml', 'contracts/en/weekday-parser.yaml']);
    assert.equal(s.contracts['contracts/en/casual-date.yaml']!.last_commit_sha, CONTRACT_COMMIT);
    assert.equal(s.contracts['contracts/en/casual-date.yaml']!.valid, true);
    assert.deepEqual(
      s.check_runs.map((c) => [c.workflow, c.event, c.conclusion]),
      [
        ['ci', 'pull_request', 'success'],
        ['gates', 'pull_request_target', 'failure'],
      ],
    );
    assert.equal(s.check_runs[0]!.heldout_seed, '9007199254740993');
    assert.equal(s.check_runs[1]!.heldout_seed, null);
    assert.equal(s.busy_jobs, 2);
    assert.ok(!JSON.stringify(s).includes('Free text'));
    assert.ok(!JSON.stringify(s).includes('Ignore previous'));
    const commitsCall = gh.calls.find((c) => c.path.startsWith(`/repos/${REPO}/commits?`))!;
    assert.ok(commitsCall.path.endsWith(`path=contracts%2Fen%2Fcasual-date.yaml&sha=${MAIN_SHA}&per_page=1`));
    assert.equal(s.main_sha, MAIN_SHA);
  });

  it('does not re-read logs for runs already recorded, and skips busy jobs when not needed', async () => {
    const gh = fakeWorld();
    const rec = new Map<string, RecordedCheck>([['4242/attempts/1', { heldout_seed: '5', failure_signature: null }]]);
    const s = await readSnapshot(gh, { repo: REPO, now: NOW, windowHours: 24, recordedChecks: rec, historyTasks: [], needBusyJobs: false });
    assert.equal(s.check_runs[0]!.heldout_seed, '5');
    assert.ok(!gh.calls.some((c) => c.path.includes('/logs') || c.path.includes('/jobs') || c.path.startsWith('/orgs/')));
    assert.equal(s.busy_jobs, null);
  });

  it('reports busy jobs as unknown when the count cannot be read', async () => {
    const gh = fakeWorld();
    gh.routes.splice(gh.routes.findIndex((r) => String(r.path).includes('orgs')), 1);
    const s = await readSnapshot(gh, { repo: REPO, now: NOW, windowHours: 24, recordedChecks: new Map(), historyTasks: [], needBusyJobs: true });
    assert.equal(s.busy_jobs, null);
    await assert.rejects(readBusyJobs(gh, 'sabbasi3-factory-lab'));
  });

  it('fails closed on a truncated tree', async () => {
    const gh = fakeWorld();
    gh.routes.unshift({ method: 'GET', path: new RegExp(`^/repos/${REPO}/git/trees/${MAIN_TREE}$`), handler: () => ({ data: { truncated: true, tree: [] } }) });
    await assert.rejects(readSnapshot(gh, { repo: REPO, now: NOW, windowHours: 24, recordedChecks: new Map(), historyTasks: [], needBusyJobs: false }), /truncated/);
  });
});

describe('review fix 3: main is resolved once to an immutable commit', () => {
  it('reads the tree, blobs and every contract history at that one SHA, even if main moves mid-read', async () => {
    const gh = fakeWorld();
    // Simulate a merge to main right after the tree is read.
    const treeRoute = gh.routes.find((r) => String(r.path).includes(MAIN_TREE))!;
    const original = treeRoute.handler;
    treeRoute.handler = (path, body) => {
      gh.refs.set('heads/main', hex40('7'));
      return original(path, body);
    };
    const s = await readSnapshot(gh, { repo: REPO, now: NOW, windowHours: 24, recordedChecks: new Map(), historyTasks: [], needBusyJobs: false });
    assert.equal(s.main_sha, MAIN_SHA);
    assert.equal(gh.calls.filter((c) => c.path === `/repos/${REPO}/git/ref/heads/main`).length, 1);
    assert.ok(gh.calls.some((c) => c.path === `/repos/${REPO}/git/commits/${MAIN_SHA}`));
    assert.ok(gh.calls.some((c) => c.path === `/repos/${REPO}/git/trees/${MAIN_TREE}?recursive=1`));
    const history = gh.calls.filter((c) => c.path.startsWith(`/repos/${REPO}/commits?`));
    assert.equal(history.length, 2);
    for (const c of history) assert.ok(c.path.includes(`&sha=${MAIN_SHA}&`), c.path);
    assert.ok(!gh.calls.some((c) => /[?&]sha=main\b|trees\/main/.test(c.path)));
  });

  it('fails closed if main does not resolve to a full commit SHA', async () => {
    const gh = fakeWorld();
    gh.refs.set('heads/main', 'not-a-sha');
    await assert.rejects(readSnapshot(gh, { repo: REPO, now: NOW, windowHours: 24, recordedChecks: new Map(), historyTasks: [], needBusyJobs: false }), /main/);
  });
});

describe('review fix 4: run discovery without a creation cutoff', () => {
  const open = hex40('1');
  const run = (id: number, over: Record<string, unknown> = {}) => ({
    id, run_attempt: 1, name: 'ci', event: 'pull_request', head_sha: hex40('9'), pull_requests: [], status: 'completed', conclusion: 'success',
    created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-16T11:00:00Z', ...over,
  });
  function world(): FakeGitHub {
    const gh = new FakeGitHub(REPO);
    gh.addRoute('GET', new RegExp(`^/repos/${REPO}/actions/runs$`), (path) => {
      const q = new URLSearchParams(path.split('?')[1]);
      if (q.get('head_sha') === open) {
        // Only found through the head lookup: an old run re-run for the open PR head.
        return { data: { workflow_runs: [run(10, { head_sha: open, run_attempt: 3, conclusion: 'failure', updated_at: '2026-10-12T00:00:00Z' })] } };
      }
      const page = Number(q.get('page') ?? '1');
      const runs =
        page === 1
          ? [run(30, { run_attempt: 2 }), run(29, { updated_at: '2026-10-10T00:00:00Z' })] // re-run (old created_at) + stale run
          : [run(30 - page)];
      return { data: { workflow_runs: runs }, next: `/repos/${REPO}/actions/runs?per_page=100&page=${page + 1}` };
    });
    return gh;
  }
  const recorded = new Map<string, RecordedCheck>([
    ['30/attempts/2', { heldout_seed: null, failure_signature: null }],
    ['10/attempts/3', { heldout_seed: null, failure_signature: 'sig' }],
    ['28/attempts/1', { heldout_seed: null, failure_signature: null }],
    ['27/attempts/1', { heldout_seed: null, failure_signature: null }],
  ]);

  it('finds re-runs with an old created_at and runs for open PR heads, filtering by updated_at', async () => {
    const gh = world();
    const runs = await readCheckRuns(gh, REPO, NOW, 24, recorded, new Set([open]));
    assert.ok(!gh.calls.some((c) => c.path.includes('created=')));
    assert.deepEqual(runs.map((r) => [r.run_id, r.run_attempt]), [[10, 3], [27, 1], [28, 1], [30, 2]]);
    assert.equal(runs.find((r) => r.run_id === 10)!.failure_signature, 'sig');
  });

  it('keeps the call count bounded', async () => {
    assert.equal(RECENT_RUN_PAGES, 3);
    const gh = world();
    const heads = new Set(Array.from({ length: 40 }, (_, i) => hex40((i % 16).toString(16)).slice(0, 38) + String(i).padStart(2, '0')));
    await readCheckRuns(gh, REPO, NOW, 24, recorded, heads);
    const listCalls = gh.calls.filter((c) => c.path.startsWith(`/repos/${REPO}/actions/runs?`));
    assert.equal(listCalls.filter((c) => !c.path.includes('head_sha=')).length, 3);
    assert.equal(listCalls.filter((c) => c.path.includes('head_sha=')).length, 30);
  });
});

describe('independent review (follow-up): truncated run lookup', () => {
  it('reports heads beyond MAX_HEAD_LOOKUPS (and non-SHA heads) as unchecked', () => {
    const heads = new Set(Array.from({ length: MAX_HEAD_LOOKUPS + 2 }, (_, i) => i.toString(16).padStart(40, '0')));
    const unchecked = uncheckedHeads(heads);
    assert.deepEqual(unchecked, [...heads].sort().slice(MAX_HEAD_LOOKUPS));
    assert.deepEqual(uncheckedHeads(new Set(['not-a-sha', hex40('1')])), ['not-a-sha']);
    assert.deepEqual(uncheckedHeads(new Set([hex40('1')])), []);
  });
});

describe('readChecksJobLog (trusted sources only)', () => {
  it('derives the signature from step results and never reads the log when the trusted first step did not run', async () => {
    const gh = new FakeGitHub(REPO);
    gh.addRoute('GET', new RegExp(`^/repos/${REPO}/actions/runs/7/attempts/1/jobs$`), () => ({
      data: {
        jobs: [
          {
            id: 70,
            name: 'checks',
            conclusion: 'failure',
            steps: [
              { number: 1, name: 'Set up job', conclusion: 'success' },
              { number: 2, name: 'Run actions/checkout@v7', conclusion: 'success' },
              { number: 3, name: 'cargo clippy -D warnings', conclusion: 'failure' },
            ],
          },
        ],
      },
    }));
    const r = await readChecksJobLog(gh, REPO, 7, 1);
    assert.deepEqual(r, { heldout_seed: null, failure_signature: 'step:cargo-clippy-d-warnings', full_regression: null });
    assert.ok(!gh.calls.some((c) => c.path.includes('/logs')), 'no log read without the trusted step');
  });
});

describe('CI signals only when the change leaves .github/ alone (review #22)', () => {
  const compareRoute = new RegExp(`^/repos/${REPO}/compare/`);
  const read = async (gh: FakeGitHub) => {
    const s = await readSnapshot(gh, { repo: REPO, now: NOW, windowHours: 24, recordedChecks: new Map(), historyTasks: [], needBusyJobs: false });
    return s.check_runs.find((r) => r.run_id === 4242)!;
  };
  const withFiles = (files: unknown, status = 200): FakeGitHub => {
    const gh = fakeWorld();
    gh.routes.unshift({ method: 'GET', path: compareRoute, handler: () => ({ status, data: { files } }) });
    return gh;
  };

  it('records the seed when the diff from main leaves .github/ alone', async () => {
    assert.equal((await read(fakeWorld())).heldout_seed, '9007199254740993');
  });

  it('records no seed and no signature (and reads no log) when the diff touches .github/, or can\'t be checked', async () => {
    const cases: FakeGitHub[] = [
      withFiles([{ filename: '.github/workflows/ci.yml' }]),
      withFiles([{ filename: 'src/x.rs', previous_filename: '.github/actions/a.yml' }]),
      withFiles([{ filename: '.github' }]),
      withFiles(Array.from({ length: 300 }, (_, i) => ({ filename: `src/f${i}.rs` }))),
      withFiles(null),
      withFiles([], 404),
    ];
    for (const gh of cases) {
      const r = await read(gh);
      assert.equal(r.heldout_seed, null);
      assert.equal(r.failure_signature, null);
      assert.ok(!gh.calls.some((c) => c.path.includes('/jobs/99/logs')), 'no log read');
    }
  });

  it('leavesGithubDirAlone: same commit is fine; malformed SHAs are not', async () => {
    const gh = fakeWorld();
    assert.equal(await leavesGithubDirAlone(gh, REPO, hex40('1'), hex40('1')), true);
    assert.equal(await leavesGithubDirAlone(gh, REPO, 'main', hex40('1')), false);
  });
});

describe('full regression step (auto-strict evidence, runner metadata only)', () => {
  it('stepConclusion: the exactly named step, or null when missing or ambiguous', () => {
    const st = (name: string, conclusion: string) => ({ number: 1, name, conclusion });
    assert.equal(stepConclusion([st('a', 'success'), st(FULL_REGRESSION_STEP, 'success')], FULL_REGRESSION_STEP), 'success');
    assert.equal(stepConclusion([st(FULL_REGRESSION_STEP, 'skipped')], FULL_REGRESSION_STEP), 'skipped');
    assert.equal(stepConclusion([st('Full regression', 'success')], FULL_REGRESSION_STEP), null, 'a similar name is not the step');
    assert.equal(stepConclusion([st(FULL_REGRESSION_STEP, 'success'), st(FULL_REGRESSION_STEP, 'success')], FULL_REGRESSION_STEP), null, 'two steps with the name: not trusted');
    assert.equal(stepConclusion([], FULL_REGRESSION_STEP), null);
  });

  it('readChecksJobLog reports the step from the checks job, even when the seed is not trusted', async () => {
    const gh = new FakeGitHub(REPO);
    gh.addRoute('GET', new RegExp(`^/repos/${REPO}/actions/runs/7/attempts/1/jobs$`), () => ({
      data: { jobs: [{ id: 70, name: 'checks', conclusion: 'success', steps: [{ number: 1, name: 'Set up job', conclusion: 'success' }, { number: 2, name: 'something else first', conclusion: 'success' }, { number: 9, name: FULL_REGRESSION_STEP, conclusion: 'success' }] }] },
    }));
    const r = await readChecksJobLog(gh, REPO, 7, 1);
    assert.deepEqual(r, { heldout_seed: null, failure_signature: null, full_regression: 'success' });
  });
});

describe('full regression: recorded once, then reused', () => {
  it('a recorded run reuses its full_regression (no second read of the jobs)', async () => {
    const recorded = new Map<string, RecordedCheck>([['4242/attempts/1', { heldout_seed: '9', failure_signature: null, full_regression: 'success' }]]);
    const runs = await readCheckRuns(fakeWorld(), REPO, NOW, 24, recorded, new Set([hex40('1')]), MAIN_SHA);
    assert.equal(runs.find((r) => r.run_id === 4242)!.full_regression, 'success');
  });

  it('recordedChecks restores it from check_result events', async () => {
    const { recordedChecks } = await import('../main.ts');
    const ev = { version: 1 as const, id: 'x', type: 'check_result', timestamp: '2026-10-16T11:10:00Z', parents: [], sha: 's', payload: { run_id: 5, run_attempt: 1, full_regression: 'success', dry_run: false } };
    assert.equal(recordedChecks([ev]).get('5/attempts/1')!.full_regression, 'success');
  });
});

describe('auto-revert inputs from GitHub', () => {
  it('mapPull keeps LabeledEvents (label, actor, bot) next to the merge-queue events', () => {
    const base = mapPull({ id: 'PR_1', number: 1, state: 'OPEN', isDraft: false, createdAt: '2026-10-16T00:00:00Z', mergedAt: null, body: '', headRefOid: hex40('1'), headRefName: 'factory/revert-5', mergeCommit: null, author: { login: 'sabbasi3-factory-controller', __typename: 'Bot' }, labels: { pageInfo: { hasNextPage: false }, nodes: [] }, reviews: { nodes: [] },
      timelineItems: { nodes: [
        { __typename: 'LabeledEvent', createdAt: '2026-10-16T01:00:00Z', label: { name: 'factory:revert-reviewed' }, actor: { login: 'sabbasi3', __typename: 'User' } },
        { __typename: 'LabeledEvent', createdAt: '2026-10-16T01:01:00Z', label: { name: 'factory:revert-reviewed' }, actor: { login: 'sabbasi3-factory-agent', __typename: 'Bot' } },
        { __typename: 'AddedToMergeQueueEvent', id: 'AMQ_1', createdAt: '2026-10-16T02:00:00Z', actor: { login: 'x', __typename: 'Bot' } },
      ] } });
    assert.equal(base.head_ref, 'factory/revert-5');
    assert.deepEqual(base.labeled_events, [
      { label: 'factory:revert-reviewed', actor: 'sabbasi3', actor_is_bot: false, at: '2026-10-16T01:00:00Z' },
      { label: 'factory:revert-reviewed', actor: 'sabbasi3-factory-agent[bot]', actor_is_bot: true, at: '2026-10-16T01:01:00Z' },
    ]);
    assert.equal(base.merge_queue_events.length, 1);
  });

  it('a re-run of a post-merge ci run carries attempt 1\'s recorded signature', async () => {
    const gh = fakeWorld();
    const r = `/repos/${REPO}`;
    gh.routes.unshift({ method: 'GET', path: new RegExp(`^${r}/actions/runs$`), handler: () => ({ data: { workflow_runs: [{ id: 777, run_attempt: 2, name: 'ci', event: 'push', head_sha: hex40('f'), pull_requests: [], status: 'completed', conclusion: 'failure', created_at: '2026-10-16T11:00:00Z', updated_at: '2026-10-16T11:30:00Z' }] } }) });
    const recorded = new Map<string, RecordedCheck>([['777/attempts/1', { heldout_seed: null, failure_signature: 'step:golden' }], ['777/attempts/2', { heldout_seed: null, failure_signature: 'step:golden' }]]);
    const runs = await readCheckRuns(gh, REPO, NOW, 24, recorded, new Set(), MAIN_SHA);
    const r777 = runs.find((x) => x.run_id === 777)!;
    assert.deepEqual([r777.event, r777.run_attempt, r777.failure_signature, r777.first_attempt_signature], ['push', 2, 'step:golden', 'step:golden']);
  });
});
