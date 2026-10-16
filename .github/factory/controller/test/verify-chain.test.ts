import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildEvent, dedupeKey } from '../audit.ts';
import { canonicalize } from '../canonical.ts';
import type { AuditEvent } from '../types.ts';
import {
  ALERT_LABEL,
  ANCHOR_LABEL,
  type Anchor,
  checkAnchors,
  formatAnchor,
  type LogFile,
  parseAnchor,
  restClient,
  runVerifier,
  TRUSTED_AUTHOR,
  verifyFullLog,
} from '../verify-chain.ts';

const REPO = 'sabbasi3-factory-lab/chrono-node-rs';
const HEAD = 'a'.repeat(40);

function chain(timestamps: string[]): AuditEvent[] {
  const out: AuditEvent[] = [];
  for (const ts of timestamps) {
    const prev = out.at(-1);
    out.push(
      buildEvent({
        type: 'heartbeat',
        timestamp: ts,
        parents: prev ? [prev.sha] : [],
        payload: { dedupe_key: dedupeKey('heartbeat', [ts]), factory_version: 'x', dry_run: true },
      }),
    );
  }
  return out;
}

function files(events: AuditEvent[]): LogFile[] {
  const byPath = new Map<string, string>();
  for (const e of events) {
    const [y, m, d] = e.timestamp.slice(0, 10).split('-');
    const p = `audit/${y}/${m}/${d}.jsonl`;
    byPath.set(p, `${byPath.get(p) ?? ''}${canonicalize(e)}\n`);
  }
  return [...byPath].map(([path, content]) => ({ path, content }));
}

const TS = ['2026-10-15T22:00:00Z', '2026-10-15T23:00:00Z', '2026-10-16T00:00:00Z', '2026-10-16T01:00:00Z'];

describe('verify-chain: full log', () => {
  it('verifies the chain across day files from a genesis event', () => {
    const r = verifyFullLog(files(chain(TS)));
    assert.ok(r.ok);
    assert.equal(r.events.length, 4);
  });

  it('fails on a tampered line, an event in the wrong day file, a stray file, or a non-genesis start', () => {
    const ev = chain(TS);
    const f = files(ev);
    const tampered = f.map((x) => ({ ...x, content: x.content.replace('"dry_run":true', '"dry_run":false') }));
    assert.ok(!verifyFullLog(tampered).ok);
    const moved: LogFile[] = [{ path: 'audit/2026/10/15.jsonl', content: f.map((x) => x.content).join('') }];
    const r = verifyFullLog(moved);
    assert.ok(!r.ok && r.errors.some((e) => e.includes('not in its day file')));
    assert.ok(!verifyFullLog([...f, { path: 'audit/notes.txt', content: 'x\n' }]).ok);
    assert.ok(!verifyFullLog([...f, { path: 'audit/2026/10/14.jsonl', content: '' }]).ok, 'empty day file');
    // Cutting off the head of the log leaves a first event with a parent: not a genesis.
    assert.ok(!verifyFullLog(files(ev.slice(1))).ok);
  });
});

describe('verify-chain: anchors', () => {
  const ev = chain(TS);
  const anchor = (n: number, at = '2026-10-16T05:00:00Z'): Anchor => ({ at, events: n, last_sha: n === 0 ? null : ev[n - 1]!.sha, audit_head: HEAD });

  it('round-trips the anchor format and rejects anything else', () => {
    const a = anchor(3);
    assert.deepEqual(parseAnchor(formatAnchor(a)), a);
    assert.equal(parseAnchor(formatAnchor(a).replace('factory-audit-anchor v1', 'factory-audit-anchor v2')), null);
    assert.equal(parseAnchor(formatAnchor({ ...a, events: -1 })), null);
    assert.equal(parseAnchor(formatAnchor({ ...a, last_sha: null })), null);
    assert.equal(parseAnchor(formatAnchor(a) + 'more text'), null);
    assert.equal(parseAnchor('factory-audit-anchor v1\n\n```json\n{"at":"x"}\n```\n'), null);
  });

  it('accepts a log that only grew since every anchor', () => {
    assert.deepEqual(checkAnchors(ev, [anchor(2, '2026-10-15T23:30:00Z'), anchor(4)]), []);
  });

  it('detects a truncated tail, rewritten history and a shrinking anchor', () => {
    assert.match(checkAnchors(ev.slice(0, 3), [anchor(4)]).join('\n'), /log shrank: .* recorded 4 events, the log now has 3/);
    const rewritten = chain(['2026-10-15T22:00:00Z', '2026-10-15T23:00:00Z', '2026-10-16T00:00:01Z', '2026-10-16T01:00:00Z']);
    assert.match(checkAnchors(rewritten, [anchor(3)]).join('\n'), /history rewritten: event #3/);
    assert.match(checkAnchors(ev, [anchor(3, '2026-10-15T23:30:00Z'), anchor(2)]).join('\n'), /fewer events/);
  });
});

/** In-memory issues API: just what the verifier uses. */
class FakeIssues {
  issues: { number: number; user: string; title: string; labels: string[]; state: string }[] = [];
  comments: { id: number; issue: number; user: string; body: string; created_at: string; updated_at: string }[] = [];
  calls: string[] = [];
  private next = 1;
  asUser = TRUSTED_AUTHOR;

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    this.calls.push(`${method} ${url.pathname}`);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    const base = `/repos/${REPO}/issues`;
    if (method === 'GET' && url.pathname === base) {
      const label = url.searchParams.get('labels');
      const state = url.searchParams.get('state');
      const page = Number(url.searchParams.get('page') ?? '1');
      const list = this.issues
        .filter((i) => (label ? i.labels.includes(label) : true) && (state === 'all' || i.state === state))
        .map((i) => ({ number: i.number, user: { login: i.user }, title: i.title, labels: i.labels.map((name) => ({ name })) }));
      return json(page === 1 ? list : []);
    }
    let m = new RegExp(`^${base}/(\\d+)/comments$`).exec(url.pathname);
    if (m && method === 'GET') {
      const page = Number(url.searchParams.get('page') ?? '1');
      const list = this.comments.filter((c) => c.issue === Number(m![1])).map((c) => ({ id: c.id, user: { login: c.user }, body: c.body, created_at: c.created_at, updated_at: c.updated_at }));
      return json(page === 1 ? list : []);
    }
    if (m && method === 'POST') {
      this.comment(Number(m[1]), String(body.body));
      return json({}, 201);
    }
    if (method === 'POST' && url.pathname === base) {
      const n = this.next++;
      this.issues.push({ number: n, user: this.asUser, title: String(body.title), labels: (body.labels as string[]) ?? [], state: 'open' });
      return json({ number: n }, 201);
    }
    return json({ message: 'not found' }, 404);
  };

  comment(issue: number, body: string, user = this.asUser): void {
    const t = '2026-10-16T05:00:00Z';
    this.comments.push({ id: this.comments.length + 1, issue, user, body, created_at: t, updated_at: t });
  }
}

describe('verify-chain: run', () => {
  const ev = chain(TS);
  const deps = (gh: FakeIssues, f: LogFile[], head: string | null = HEAD, now = '2026-10-16T05:00:00Z') => ({
    gh: restClient(REPO, 't', gh.fetch),
    repo: REPO,
    files: f,
    auditHead: head,
    now: new Date(now),
    runUrl: 'https://github.com/x/y/actions/runs/1',
    log: () => {},
  });

  it('first run creates the anchor issue and anchors the log; later runs append anchors', async () => {
    const gh = new FakeIssues();
    const r1 = await runVerifier(deps(gh, files(ev.slice(0, 3))));
    assert.ok(r1.ok);
    assert.equal(gh.issues.length, 1);
    assert.deepEqual(gh.issues[0]!.labels, [ANCHOR_LABEL]);
    assert.equal(gh.comments.length, 1);
    assert.deepEqual(parseAnchor(gh.comments[0]!.body), { at: '2026-10-16T05:00:00Z', events: 3, last_sha: ev[2]!.sha, audit_head: HEAD });
    const r2 = await runVerifier(deps(gh, files(ev), HEAD, '2026-10-17T05:00:00Z'));
    assert.ok(r2.ok);
    assert.equal(gh.issues.length, 1, 'the same anchor issue is reused');
    assert.equal(gh.comments.length, 2);
  });

  it('a truncated log fails and opens one alert issue, then comments on it', async () => {
    const gh = new FakeIssues();
    await runVerifier(deps(gh, files(ev)));
    const bad = await runVerifier(deps(gh, files(ev.slice(0, 2)), HEAD, '2026-10-17T05:00:00Z'));
    assert.ok(!bad.ok);
    const alerts = gh.issues.filter((i) => i.labels.includes(ALERT_LABEL));
    assert.equal(alerts.length, 1);
    await runVerifier(deps(gh, files(ev.slice(0, 2)), HEAD, '2026-10-18T05:00:00Z'));
    assert.equal(gh.issues.filter((i) => i.labels.includes(ALERT_LABEL)).length, 1);
    assert.equal(gh.comments.filter((c) => c.issue === alerts[0]!.number).length, 1, 'second failure comments on the open alert');
    assert.equal(gh.comments.filter((c) => c.issue !== alerts[0]!.number).length, 1, 'no new anchor after a failure');
  });

  it('fails when the branch is gone but anchors recorded it', async () => {
    const gh = new FakeIssues();
    await runVerifier(deps(gh, files(ev)));
    const r = await runVerifier(deps(gh, [], null, '2026-10-17T05:00:00Z'));
    assert.ok(!r.ok);
    assert.match(r.errors.join('\n'), /audit branch is gone/);
  });

  it('ignores anchors and anchor issues from anyone but the trusted author', async () => {
    const gh = new FakeIssues();
    await runVerifier(deps(gh, files(ev)));
    // A forged anchor claiming 99 events, on the real issue and on a stranger's look-alike issue.
    const forged = formatAnchor({ at: '2026-10-16T06:00:00Z', events: 99, last_sha: ev[0]!.sha, audit_head: HEAD });
    gh.comment(1, forged, 'someone');
    gh.asUser = 'someone';
    gh.issues.push({ number: 50, user: 'someone', title: 'Audit chain anchors', labels: [ANCHOR_LABEL], state: 'open' });
    gh.comment(50, forged, 'someone');
    gh.asUser = TRUSTED_AUTHOR;
    assert.ok((await runVerifier(deps(gh, files(ev), HEAD, '2026-10-17T05:00:00Z'))).ok);
  });

  it('fails when an anchor comment was edited', async () => {
    const gh = new FakeIssues();
    await runVerifier(deps(gh, files(ev)));
    gh.comments[0]!.updated_at = '2026-10-16T09:00:00Z';
    const r = await runVerifier(deps(gh, files(ev), HEAD, '2026-10-17T05:00:00Z'));
    assert.ok(!r.ok);
    assert.match(r.errors.join('\n'), /was edited/);
  });

  it('does nothing for an empty log with no anchors, and refuses calls outside issues', async () => {
    const gh = new FakeIssues();
    const r = await runVerifier(deps(gh, [], null));
    assert.ok(r.ok);
    assert.equal(r.anchor, null);
    assert.equal(gh.issues.length, 0);
    await assert.rejects(restClient(REPO, 't', gh.fetch).post(`/repos/${REPO}/git/refs`, {}), /refusing/);
    await assert.rejects(restClient(REPO, 't', gh.fetch).get('/repos/other/repo/issues'), /refusing/);
  });
});
