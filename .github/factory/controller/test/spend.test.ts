import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { crc32, deflateRawSync } from 'node:zlib';
import { FakeGitHub } from '../fake.ts';
import { jobInferred, readSpendToday, readZip, runAIC, spendSnapshotFields } from '../spend.ts';
import { readFileSync } from 'node:fs';
import { NOW, REPO } from './helpers.ts';

const CAPS = { implement: 500, threat_detection: 400 };
const r = `/repos/${REPO}`;

/** A minimal ZIP writer for tests (stored or deflated entries). */
function zip(files: Record<string, string>, opts: { method?: 0 | 8; corruptCrc?: string; flags?: number } = {}): Uint8Array {
  const method = opts.method ?? 8;
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8');
    const body = method === 8 ? deflateRawSync(data) : data;
    const crc = opts.corruptCrc === name ? (crc32(data) ^ 1) >>> 0 : crc32(data);
    const n = Buffer.from(name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(opts.flags ?? 0, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(opts.flags ?? 0, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, body);
    central.push(ch, n);
    offset += lh.length + n.length + body.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, eocd]));
}

const usageZip = (agent: number | null, detection: number[] = []) =>
  zip({
    ...(agent === null ? {} : { 'agent_usage.json': JSON.stringify({ input_tokens: 10, output_tokens: 2, ai_credits: agent }) + '\n' }),
    'detection/token_usage.jsonl': detection.map((c, i) => JSON.stringify({ event: 'token_usage', request_id: `r${i}`, ai_credits_this_response: c })).join('\n') + (detection.length ? '\n' : ''),
    'aw_info.json': '{}',
  });

const executed = (conclusion = 'success') => ({ steps: [{ name: 'Set up job', conclusion: 'success' }, { name: 'Execute GitHub Copilot CLI', conclusion }] });

interface FakeRun {
  id: number;
  status?: string;
  attempt?: number;
  created?: string;
  agent?: string | null; // Execute step conclusion; null = job absent
  detection?: string | null;
  artifacts?: { id: number; name: string; expired?: boolean }[];
  zips?: Record<number, Uint8Array | { status: number }>;
}

function world(runs: FakeRun[], listStatus = 200): FakeGitHub {
  const gh = new FakeGitHub(REPO);
  gh.addRoute('GET', new RegExp(`^${r}/actions/workflows/implement\\.lock\\.yml/runs$`), () =>
    listStatus === 200
      ? { data: { workflow_runs: runs.map((x) => ({ id: x.id, status: x.status ?? 'completed', run_attempt: x.attempt ?? 1, created_at: x.created ?? '2026-10-16T08:00:00Z' })) } }
      : { status: listStatus, data: null },
  );
  for (const x of runs) {
    gh.addRoute('GET', new RegExp(`^${r}/actions/runs/${x.id}/attempts/1/jobs$`), () => ({
      data: {
        jobs: [
          { name: 'activation', steps: [] },
          ...(x.agent === null ? [] : [{ name: 'agent', ...executed(x.agent ?? 'success') }]),
          ...(x.detection === null || x.detection === undefined ? [] : [{ name: 'detection', ...executed(x.detection) }]),
        ],
      },
    }));
    gh.addRoute('GET', new RegExp(`^${r}/actions/runs/${x.id}/artifacts$`), () => ({ data: { artifacts: (x.artifacts ?? []).map((a) => ({ expired: false, ...a })) } }));
    for (const [aid, z] of Object.entries(x.zips ?? {})) {
      gh.addRoute('GET', new RegExp(`^${r}/actions/artifacts/${aid}/zip$`), () => (z instanceof Uint8Array ? { data: z } : { status: z.status, data: null }));
    }
  }
  return gh;
}

describe('spend collector: today\'s implement spend', () => {
  it('no runs today → 0 (a measured zero, not unknown)', async () => {
    const res = await readSpendToday(world([]), REPO, NOW, CAPS);
    assert.deepEqual(res, { aic: 0, runs: [] });
  });

  it('a queued or in-progress run is reserved at the per-run caps (implement + threat detection)', async () => {
    const res = await readSpendToday(world([{ id: 1, status: 'in_progress' }, { id: 2, status: 'queued' }]), REPO, NOW, CAPS);
    assert.deepEqual(res, { aic: 1800, runs: [{ run_id: 1, status: 'reserved', aic: 900 }, { run_id: 2, status: 'reserved', aic: 900 }] });
  });

  it('a completed run is measured from its usage artifact: agent ai_credits + detection responses', async () => {
    const gh = world([{ id: 3, detection: 'success', artifacts: [{ id: 30, name: 'usage' }, { id: 31, name: 'agent' }], zips: { 30: usageZip(123.456, [1.5, 0.25]) } }]);
    const res = await readSpendToday(gh, REPO, NOW, CAPS);
    assert.deepEqual(res, { aic: 125.206, runs: [{ run_id: 3, status: 'measured', aic: 125.206 }] });
    assert.ok(gh.calls.some((c) => c.path === `${r}/actions/artifacts/30/zip`));
  });

  it('a run whose Execute steps were skipped (e.g. validation failed) made no model calls → 0, without an artifact', async () => {
    const res = await readSpendToday(world([{ id: 4, agent: 'skipped' }, { id: 5, agent: null }]), REPO, NOW, CAPS);
    assert.deepEqual(res, { aic: 0, runs: [{ run_id: 4, status: 'no_inference', aic: 0 }, { run_id: 5, status: 'no_inference', aic: 0 }] });
  });

  it('measured + reserved add up; runs created before today are not counted', async () => {
    const res = await readSpendToday(
      world([
        { id: 6, artifacts: [{ id: 60, name: 'usage' }], zips: { 60: usageZip(40) } },
        { id: 7, status: 'in_progress' },
        { id: 8, created: '2026-10-15T23:59:59Z', status: 'in_progress' },
      ]),
      REPO,
      NOW,
      CAPS,
    );
    assert.equal(res.aic, 940);
    assert.deepEqual(res.runs.map((x) => x.run_id), [6, 7]);
  });

  describe('unreadable → unknown (fail closed: nothing is dispatched)', () => {
    const cases: [string, FakeRun[], RegExp][] = [
      ['no usage artifact', [{ id: 9 }], /run 9 has 0 usage artifacts/],
      ['an expired artifact', [{ id: 9, artifacts: [{ id: 90, name: 'usage', expired: true }] }], /expired/],
      ['two usage artifacts', [{ id: 9, artifacts: [{ id: 90, name: 'usage' }, { id: 91, name: 'usage' }] }], /2 usage artifacts/],
      ['a download error', [{ id: 9, artifacts: [{ id: 90, name: 'usage' }], zips: { 90: { status: 410 } } }], /could not be read/],
      ['no agent_usage.json', [{ id: 9, artifacts: [{ id: 90, name: 'usage' }], zips: { 90: usageZip(null) } }], /agent_usage.json is missing/],
      ['detection ran without records', [{ id: 9, detection: 'success', artifacts: [{ id: 90, name: 'usage' }], zips: { 90: usageZip(5, []) } }], /recorded no usage/],
      ['a corrupt zip entry', [{ id: 9, artifacts: [{ id: 90, name: 'usage' }], zips: { 90: zip({ 'agent_usage.json': '{"ai_credits":5}' }, { corruptCrc: 'agent_usage.json' }) } }], /CRC/],
      ['a re-run', [{ id: 9, attempt: 2 }], /re-run/],
      ['a queued re-run', [{ id: 9, attempt: 2, status: 'queued' }], /re-run \(attempt 2\)/],
      ['an in-progress re-run', [{ id: 9, attempt: 3, status: 'in_progress' }], /re-run \(attempt 3\)/],
    ];
    for (const [what, runs, reason] of cases) {
      it(what, async () => {
        const res = await readSpendToday(world(runs), REPO, NOW, CAPS);
        assert.equal(res.aic, null);
        assert.match((res as { reason: string }).reason, reason);
      });
    }

    it('the run list can\'t be read', async () => {
      const res = await readSpendToday(world([], 500), REPO, NOW, CAPS);
      assert.equal(res.aic, null);
      assert.match((res as { reason: string }).reason, /could not be listed/);
    });
  });
});

describe('spend collector: parts', () => {
  it('readZip extracts only the wanted files (stored or deflated) and checks size and CRC', () => {
    for (const method of [0, 8] as const) {
      const files = readZip(zip({ 'a.json': '{"x":1}', 'b/c.jsonl': 'line\n', other: 'skip' }, { method }), ['a.json', 'b/c.jsonl']);
      assert.deepEqual([...files], [['a.json', '{"x":1}'], ['b/c.jsonl', 'line\n']]);
    }
    assert.throws(() => readZip(zip({ 'a.json': '{}' }, { corruptCrc: 'a.json' }), ['a.json']), /CRC/);
    assert.throws(() => readZip(zip({ 'a.json': '{}' }, { flags: 1 }), ['a.json']), /encrypted/);
    assert.throws(() => readZip(new Uint8Array([1, 2, 3]), ['a.json']), /not a zip/);
    assert.throws(() => readZip(zip({ 'a.json': 'x'.repeat(100) }), ['a.json'], 50), /too large/);
  });

  it('runAIC requires the accounting of every part that ran', () => {
    const files = new Map([
      ['agent_usage.json', '{"ai_credits":2.5}'],
      ['detection/token_usage.jsonl', '{"ai_credits_this_response":0.5}\n\n{"ai_credits_this_response":0.25}\n'],
    ]);
    assert.equal(runAIC(files, ['agent', 'detection']), 3.25);
    assert.equal(runAIC(files, ['agent']), 2.5);
    assert.equal(runAIC(new Map(), []), 0);
    assert.throws(() => runAIC(new Map([['agent_usage.json', '{"ai_credits":-1}']]), ['agent']), /valid ai_credits/);
    assert.throws(() => runAIC(new Map([['agent_usage.json', '{"ai_credits":"5"}']]), ['agent']), /valid ai_credits/);
    assert.throws(() => runAIC(new Map([['detection/token_usage.jsonl', '{"x":1}\n']]), ['detection']), /ai_credits_this_response/);
    assert.throws(() => runAIC(files, ['agent', 'evals']), /evals made model calls but evals\/token_usage.jsonl is missing/, 'a job gh-aw adds later is never silently free');
    // Missing response records: a cumulative total above the response sum is unknown, not 1 AIC.
    const gap = new Map([['detection/token_usage.jsonl', '{"ai_credits_this_response":1,"ai_credits_total":25}\n']]);
    assert.throws(() => runAIC(gap, ['detection']), /reports 25 AIC in total but its responses add up to 1: records are missing/);
    const consistent = new Map([['detection/token_usage.jsonl', '{"ai_credits_this_response":0.4,"ai_credits_total":0.4}\n{"ai_credits_this_response":0.3242,"ai_credits_total":0.7242}\n']]);
    assert.equal(runAIC(consistent, ['detection']), 0.7242, 'a matching cumulative total (with rounding) is fine');
  });

  it('a real gh-aw usage artifact (v0.92.x run of an agentic workflow) parses to the same totals as its per-response logs', () => {
    // test/fixtures/usage-artifact.zip: the `usage` artifact of a public gh-aw agentic workflow run
    // (github/gh-aw), with only the accounting files kept. Agent 20.0578 AIC (3 responses),
    // detection 0.724402 (2), evals 0.473833 (1).
    const z = new Uint8Array(readFileSync(new URL('./fixtures/usage-artifact.zip', import.meta.url)));
    const jobs = ['agent', 'detection', 'evals'];
    const files = readZip(z, jobs.map((j) => (j === 'agent' ? 'agent_usage.json' : `${j}/token_usage.jsonl`)));
    assert.equal(Math.round(runAIC(files, jobs) * 1e6) / 1e6, 21.256035);
  });

  it('jobInferred: the Execute step ran', () => {
    assert.equal(jobInferred(executed('success')), true);
    assert.equal(jobInferred(executed('failure')), true, 'a failed agent step may still have spent');
    assert.equal(jobInferred(executed('skipped')), false);
    assert.equal(jobInferred(undefined), false);
    assert.equal(jobInferred({ steps: [{ name: 'Validate dispatch and contract freshness', conclusion: 'failure' }] }), false);
  });

  it('spend_snapshot fields list the sources', () => {
    assert.deepEqual(spendSnapshotFields('2026-10-16', { aic: 940, runs: [{ run_id: 6, status: 'measured', aic: 40 }, { run_id: 7, status: 'reserved', aic: 900 }] }), {
      day: '2026-10-16',
      aic_today: 940,
      runs: [{ run_id: 6, status: 'measured', aic: 40 }, { run_id: 7, status: 'reserved', aic: 900 }],
      runs_total: 2,
    });
  });
});
