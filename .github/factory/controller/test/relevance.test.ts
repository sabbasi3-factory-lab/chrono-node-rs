import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createClient, rateReserveSkip, RATE_RESERVE, readRateLimit, type FetchFn } from '../github.ts';
import { FACTORY_BOT_LOGINS, FACTORY_BRANCH_PREFIXES, relevance } from '../relevance.ts';

const prEvent = (ref: string, login = 'sabbasi3') => ({ pull_request: { head: { ref }, user: { login } } });
const runEvent = (event: string, head_branch: string | null, login = 'sabbasi3') => ({ workflow_run: { event, head_branch, actor: { login } } });

describe('controller relevance: PR-driven events poll only for factory-owned branches', () => {
  it('an onboarding PR and an intake PR (and their ci/gates runs) still poll', () => {
    for (const ref of ['factory/onboard/zh-hans', 'factory/intake/ar-fix-0a1b2c3d']) {
      assert.equal(relevance('pull_request_target', prEvent(ref, 'sabbasi3-factory-controller[bot]')).poll, true, ref);
      assert.equal(relevance('pull_request_target', prEvent(ref)).poll, true, `${ref} (person's push)`);
      assert.equal(relevance('workflow_run', runEvent('pull_request', ref)).poll, true, `${ref} ci`);
      assert.equal(relevance('workflow_run', runEvent('pull_request_target', ref)).poll, true, `${ref} gates`);
    }
  });

  it("a sabbasi/* PR doesn't poll, nor do ci/gates runs on it", () => {
    assert.deepEqual(relevance('pull_request_target', prEvent('sabbasi/vi-dates')), { poll: false, reason: 'pr on sabbasi/vi-dates: no factory automation owns it' });
    assert.equal(relevance('workflow_run', runEvent('pull_request', 'sabbasi/vi-dates')).poll, false);
    assert.equal(relevance('workflow_run', runEvent('pull_request_target', 'sabbasi/controller-rate')).poll, false);
  });

  it('every factory branch prefix polls: task, repair, onboarding, intake, deps, upstream, revert, merge queue', () => {
    for (const ref of [
      'factory/ar-relative-date-format-parser-b691a444e9989201', // implement (task) and repair (same branch)
      'factory/onboard/it',
      'factory/intake/vi-fix-12345678',
      'factory/deps/regex-1.11.0',
      'factory/upstream/v2.9.0',
      'factory/revert-501',
      'gh-readonly-queue/main/pr-501-0123456789abcdef0123456789abcdef01234567',
    ]) {
      assert.ok(FACTORY_BRANCH_PREFIXES.some((p) => ref.startsWith(p)), ref);
      assert.equal(relevance('pull_request_target', prEvent(ref)).poll, true, ref);
      assert.equal(relevance('workflow_run', runEvent('pull_request', ref)).poll, true, ref);
    }
  });

  it("the factory's Apps own their PRs whatever the branch (older agent PRs and drills were unprefixed)", () => {
    for (const login of FACTORY_BOT_LOGINS) {
      assert.equal(relevance('pull_request_target', prEvent('drill-gate-perf-617e6fbeb48a2034', login)).poll, true, login);
      assert.equal(relevance('workflow_run', runEvent('pull_request', 'queue-probe/r2-2a77ccc1179cfeeb', login)).poll, true, login);
    }
  });

  it('push to main, merge_group, issues, schedule, workflow_dispatch and non-PR workflow runs always poll', () => {
    for (const name of ['push', 'merge_group', 'issues', 'schedule', 'workflow_dispatch']) assert.equal(relevance(name, {}).poll, true, name);
    assert.equal(relevance('workflow_run', runEvent('push', 'main')).poll, true);
    assert.equal(relevance('workflow_run', runEvent('merge_group', 'gh-readonly-queue/main/pr-1-abc')).poll, true);
    assert.equal(relevance('workflow_run', runEvent('workflow_dispatch', 'main')).poll, true, 'the reviewer');
    assert.equal(relevance('workflow_run', runEvent('push', 'sabbasi/x')).poll, false);
  });

  it('a malformed or missing payload polls (doubt never skips)', () => {
    assert.equal(relevance('pull_request_target', null).poll, true);
    assert.equal(relevance('pull_request_target', { pull_request: { head: {} } }).poll, true);
    assert.equal(relevance('workflow_run', { workflow_run: { event: 'pull_request', head_branch: null } }).poll, true);
    assert.equal(relevance('workflow_run', 'garbage').poll, true);
    assert.equal(relevance('something_new', {}).poll, true);
  });
});

const rl = (remaining: number) => ({ limit: 5000, remaining, used: 5000 - remaining, reset: 1_762_732_800 });

describe('controller rate reserve', () => {
  it('an event poll below the reserve is skipped, with the reset time; at or above it, polls', () => {
    assert.match(rateReserveSkip('workflow_run', rl(RATE_RESERVE - 1)) ?? '', /^rate_reserve: 999 of 5000 API calls left \(reserve 1000\); this workflow_run poll is skipped until the quota resets at 2025-11-10T00:00:00.000Z$/);
    assert.equal(rateReserveSkip('pull_request_target', rl(RATE_RESERVE)), null);
    assert.notEqual(rateReserveSkip('issues', rl(0)), null);
    assert.notEqual(rateReserveSkip('push', rl(10)), null);
  });

  it('scheduled and follow-up (workflow_dispatch) polls always run', () => {
    for (const t of ['schedule', 'workflow_dispatch', 'local']) assert.equal(rateReserveSkip(t, rl(0)), null, t);
  });

  it('readRateLimit reads the core quota and fails on a malformed answer', async () => {
    const ok: FetchFn = async () => new Response(JSON.stringify({ resources: { core: rl(4200) } }), { status: 200 });
    assert.deepEqual(await readRateLimit(createClient('t', 'o/r', ok)), rl(4200));
    const bad: FetchFn = async () => new Response(JSON.stringify({ resources: { core: { limit: 5000 } } }), { status: 200 });
    await assert.rejects(readRateLimit(createClient('t', 'o/r', bad)), /rate_limit: bad remaining/);
  });

  it('a 403 from a spent quota says so and when it resets; another 403 stays plain', async () => {
    const spent: FetchFn = async () => new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1762732800' } });
    await assert.rejects(createClient('t', 'o/r', spent).request('GET', '/repos/o/r/issues'), /GET \/repos\/o\/r\/issues: HTTP 403 \(API rate limit spent; resets 2025-11-10T00:00:00.000Z\)$/);
    const denied: FetchFn = async () => new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '4000' } });
    await assert.rejects(createClient('t', 'o/r', denied).request('GET', '/repos/o/r/issues'), /HTTP 403$/);
  });
});
