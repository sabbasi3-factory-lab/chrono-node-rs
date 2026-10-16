import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertAllowedRequest,
  createClient,
  GitHubApiError,
  mapPull,
  nextPathFromLink,
  paginate,
  parseCheckLog,
  readBusyJobs,
  readSnapshot,
} from '../github.ts';
import { FakeGitHub } from '../fake.ts';
import type { RecordedCheck } from '../github.ts';
import { hex40, NOW, REPO } from './helpers.ts';
import { CONTRACT_COMMIT, fakeWorld } from './world.ts';

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

describe('check log parsing (held-out seed)', () => {
  it('extracts the exact seed line after the timestamp prefix, as a decimal string', () => {
    const log = [
      '2026-10-16T11:00:00.0000000Z ##[group]Run echo "factory-heldout-seed: $SEED"',
      '2026-10-16T11:00:00.0000000Z \u001b[36;1mecho "factory-heldout-seed: $SEED"\u001b[0m',
      '2026-10-16T11:00:01.0000000Z factory-heldout-seed: 18446744073709551615',
      '2026-10-16T11:00:02.0000000Z factory-failure-signature: golden:en/weekday#17',
    ].join('\n');
    assert.deepEqual(parseCheckLog(log), { heldout_seed: '18446744073709551615', failure_signature: 'golden:en/weekday#17' });
  });

  it('ignores the seed printed by the contract-seeded (--seed) comparison step', () => {
    const log = [
      '2026-10-16T11:00:00.0000000Z ##[group]Run node compare/compare.js --seed "$SEED" --phrases "$PHRASES" --rust ../target/debug/chrono-rs-json',
      '2026-10-16T11:00:00.1000000Z ##[endgroup]',
      '2026-10-16T11:00:05.0000000Z factory-heldout-seed: 42',
      '2026-10-16T11:00:06.0000000Z ##[group]Run node compare/compare.js --phrases 2000 --rust ../target/debug/chrono-rs-json',
      '2026-10-16T11:00:06.1000000Z ##[endgroup]',
      '2026-10-16T11:00:09.0000000Z factory-heldout-seed: 3141592653',
    ].join('\n');
    assert.equal(parseCheckLog(log).heldout_seed, '3141592653');
    // Without step markers, two different seeds conflict → null.
    assert.equal(parseCheckLog('factory-heldout-seed: 42\nfactory-heldout-seed: 3141592653').heldout_seed, null);
  });

  it('ignores near-misses and fails closed on conflicting values', () => {
    assert.equal(parseCheckLog('factory-heldout-seed: 12 extra').heldout_seed, null);
    assert.equal(parseCheckLog('factory-heldout-seed: -1').heldout_seed, null);
    assert.equal(parseCheckLog('factory-heldout-seed: 012').heldout_seed, null);
    assert.equal(parseCheckLog('x factory-heldout-seed: 12').heldout_seed, null);
    assert.equal(parseCheckLog('factory-heldout-seed: 1\nfactory-heldout-seed: 2').heldout_seed, null);
    assert.equal(parseCheckLog('factory-heldout-seed: 7\r\nfactory-heldout-seed: 7').heldout_seed, '7');
    assert.equal(parseCheckLog('factory-failure-signature: has spaces').failure_signature, null);
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
    assert.match(commitsCall.path, /path=contracts%2Fen%2Fcasual-date\.yaml&sha=main&per_page=1/);
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
    gh.routes.unshift({ method: 'GET', path: new RegExp(`^/repos/${REPO}/git/trees/main$`), handler: () => ({ data: { truncated: true, tree: [] } }) });
    await assert.rejects(readSnapshot(gh, { repo: REPO, now: NOW, windowHours: 24, recordedChecks: new Map(), historyTasks: [], needBusyJobs: false }), /truncated/);
  });
});
