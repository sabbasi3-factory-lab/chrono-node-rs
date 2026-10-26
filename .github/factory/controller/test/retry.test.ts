import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createClient, graphql, GitHubApiError, isRetryableRead, MAX_TRIES, retryDelayMs } from '../github.ts';

const REPO = 'sabbasi3-factory-lab/chrono-node-rs';

/** A fetch that answers with the given statuses in order (then the last one forever). */
function scripted(statuses: number[], body: unknown = { data: { ok: true } }) {
  const calls: { url: string; method: string }[] = [];
  const fetchFn = async (url: string, init: RequestInit): Promise<Response> => {
    const status = statuses[Math.min(calls.length, statuses.length - 1)]!;
    calls.push({ url, method: String(init.method) });
    return new Response(status === 200 ? JSON.stringify(body) : 'bad gateway', { status });
  };
  const sleeps: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    sleeps.push(ms);
  };
  return { calls, sleeps, fetchFn, sleep };
}

describe('GitHub client: transient 5xx on reads are retried; writes never are', () => {
  it('a GET that gets 502 then 504 then 200 succeeds on the 3rd try, with backoff between tries', async () => {
    const w = scripted([502, 504, 200], [{ number: 1 }]);
    const c = createClient('t', REPO, w.fetchFn, 'dry-run', w.sleep);
    const res = await c.request('GET', `/repos/${REPO}/issues?state=open&per_page=100`);
    assert.deepEqual(res.data, [{ number: 1 }]);
    assert.equal(w.calls.length, 3);
    assert.equal(w.sleeps.length, 2);
  });

  it('the 3rd failure still fails the poll (GitHubApiError with that status, no 4th try)', async () => {
    for (const status of [502, 503, 504]) {
      const w = scripted([status]);
      const c = createClient('t', REPO, w.fetchFn, 'dry-run', w.sleep);
      await assert.rejects(c.request('GET', `/repos/${REPO}/issues`), (e: unknown) => e instanceof GitHubApiError && e.status === status);
      assert.equal(w.calls.length, MAX_TRIES, String(status));
      assert.equal(MAX_TRIES, 3);
    }
  });

  it('a write is never retried: one 502 on a live POST/PATCH fails at once', async () => {
    const writes: [string, string, unknown][] = [
      ['POST', `/repos/${REPO}/issues/3/labels`, { labels: ['factory:picked'] }],
      ['POST', `/repos/${REPO}/git/blobs`, { content: 'x', encoding: 'utf-8' }],
    ];
    for (const [method, path, body] of writes) {
      const w = scripted([502, 200]);
      const c = createClient('t', REPO, w.fetchFn, 'live', w.sleep);
      await assert.rejects(c.request(method as 'POST', path, { body }), /HTTP 502/);
      assert.equal(w.calls.length, 1, `${method} ${path}`);
      assert.deepEqual(w.sleeps, []);
    }
  });

  it('GraphQL: a read-only query is retried, a mutation is not', async () => {
    const q = scripted([504, 200]);
    assert.deepEqual(await graphql(createClient('t', REPO, q.fetchFn, 'dry-run', q.sleep), 'query { viewer { login } }', {}), { ok: true });
    assert.equal(q.calls.length, 2);
    const m = scripted([504, 200]);
    const live = createClient('t', REPO, m.fetchFn, 'live', m.sleep);
    const enqueue = 'mutation($id: ID!, $head: GitObjectID!) { enqueuePullRequest(input: {pullRequestId: $id, expectedHeadOid: $head}) { mergeQueueEntry { id } } }';
    await assert.rejects(graphql(live, enqueue, { id: 'PR_1', head: 'a'.repeat(40) }), /HTTP 504/);
    assert.equal(m.calls.length, 1);
  });

  it('other errors are not retried (500, 404, 403)', async () => {
    for (const status of [500, 404, 403]) {
      const w = scripted([status, 200]);
      const c = createClient('t', REPO, w.fetchFn, 'dry-run', w.sleep);
      await assert.rejects(c.request('GET', `/repos/${REPO}/issues`), /HTTP/);
      assert.equal(w.calls.length, 1, String(status));
    }
  });

  it('classifies reads and writes like the allowlist; backoff grows with jitter', () => {
    assert.equal(isRetryableRead('GET', '/x', undefined), true);
    assert.equal(isRetryableRead('POST', '/graphql', { query: '{ viewer { login } }' }), true);
    assert.equal(isRetryableRead('POST', '/graphql', { query: 'query { a } mutation { b }' }), false);
    assert.equal(isRetryableRead('POST', '/graphql', { query: 'mutation { b }' }), false);
    assert.equal(isRetryableRead('POST', '/repos/x/issues', {}), false);
    assert.equal(isRetryableRead('PATCH', '/repos/x/git/refs/heads/audit', {}), false);
    assert.equal(retryDelayMs(1, () => 0), 250);
    assert.equal(retryDelayMs(1, () => 0.999), 1249);
    assert.equal(retryDelayMs(2, () => 0.999), 2248);
  });
});
