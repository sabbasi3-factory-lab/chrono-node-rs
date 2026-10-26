import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { crc32, deflateRawSync } from 'node:zlib';
import { FakeGitHub } from '../fake.ts';
import { jobInferred, readSpendToday, readZip, runAIC, spendSnapshotFields } from '../spend.ts';
import { readFileSync } from 'node:fs';
import { NOW, REPO } from './helpers.ts';

const CAPS = { implement: 500, repair: 300, reviewer_agent: 200, threat_detection: 400 };
/** Today's part of a spend result (the per-task part is tested on its own). */
const today = (r: Awaited<ReturnType<typeof readSpendToday>>) => ({ aic: r.aic, runs: r.runs });
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
  /** The run's display_title (run-name), e.g. `Implement en/a #3 attempt 1`. */
  title?: string;
  /** Job-level status for every job (default: none given, as for a completed run). */
  jobStatus?: string;
  /** Add the final `conclusion` job with this status. */
  conclusion?: string;
  /** HTTP status for the jobs list (default 200). */
  jobsStatus?: number;
}

function world(runs: FakeRun[], listStatus = 200, repairRuns: { id: number; status?: string; attempt?: number }[] = [], repairListStatus = 200, reviewRuns: { id: number; status?: string }[] = [], reviewListStatus = 200): FakeGitHub {
  const gh = new FakeGitHub(REPO);
  gh.addRoute('GET', new RegExp(`^${r}/actions/workflows/review\\.lock\\.yml/runs$`), () =>
    reviewListStatus === 200
      ? { data: { workflow_runs: reviewRuns.map((x) => ({ id: x.id, status: x.status ?? 'in_progress', run_attempt: 1, created_at: '2026-10-16T08:00:00Z' })) } }
      : { status: reviewListStatus, data: null },
  );
  gh.addRoute('GET', new RegExp(`^${r}/actions/workflows/repair\\.lock\\.yml/runs$`), () =>
    repairListStatus === 200
      ? { data: { workflow_runs: repairRuns.map((x) => ({ id: x.id, status: x.status ?? 'in_progress', run_attempt: x.attempt ?? 1, created_at: '2026-10-16T08:00:00Z' })) } }
      : { status: repairListStatus, data: null },
  );
  gh.addRoute('GET', new RegExp(`^${r}/actions/workflows/implement\\.lock\\.yml/runs$`), () =>
    listStatus === 200
      ? { data: { workflow_runs: runs.map((x) => ({ id: x.id, status: x.status ?? 'completed', run_attempt: x.attempt ?? 1, created_at: x.created ?? '2026-10-16T08:00:00Z', display_title: x.title ?? 'Implement one factory task' })) } }
      : { status: listStatus, data: null },
  );
  for (const x of runs) {
    const st = x.jobStatus === undefined ? {} : { status: x.jobStatus };
    gh.addRoute('GET', new RegExp(`^${r}/actions/runs/${x.id}/attempts/1/jobs$`), () => x.jobsStatus ? { status: x.jobsStatus, data: null } : ({
      data: {
        jobs: [
          { name: 'activation', steps: [], ...st },
          ...(x.agent === null ? [] : [{ name: 'agent', ...executed(x.agent ?? 'success'), ...st }]),
          ...(x.detection === null || x.detection === undefined ? [] : [{ name: 'detection', ...executed(x.detection), ...st }]),
          ...(x.conclusion === undefined ? [] : [{ name: 'conclusion', steps: [], status: x.conclusion }]),
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
    assert.deepEqual(today(res), { aic: 0, runs: [] });
  });

  it('per task: today and yesterday by the task in the run name; runs naming no task count against every task', async () => {
    const res = await readSpendToday(
      world([
        { id: 1, title: 'Implement en/a #3 attempt 1', artifacts: [{ id: 10, name: 'usage' }], zips: { 10: usageZip(30) } },
        { id: 2, title: 'Implement en/a #3 attempt 1', created: '2026-10-15T20:00:00Z', artifacts: [{ id: 20, name: 'usage' }], zips: { 20: usageZip(5) } },
        { id: 3, title: 'Implement en/b #4 attempt 1', status: 'in_progress' },
        { id: 4, title: 'Implement one factory task', artifacts: [{ id: 40, name: 'usage' }], zips: { 40: usageZip(7) } },
        { id: 5, title: 'Implement en/a #3 attempt 1', created: '2026-10-14T20:00:00Z', status: 'in_progress' },
      ]),
      REPO,
      NOW,
      CAPS,
    );
    assert.equal(res.aic, 937, 'today: 30 + 900 + 7');
    assert.deepEqual(res.tasks, { by_task: { 'en/a': 35, 'en/b': 900 }, unattributed: 7 });
  });

  it('an unreadable run from yesterday makes only the per-task spend unknown (today\'s total stands)', async () => {
    const res = await readSpendToday(world([{ id: 1, artifacts: [{ id: 10, name: 'usage' }], zips: { 10: usageZip(30) } }, { id: 2, created: '2026-10-15T20:00:00Z', artifacts: [{ id: 20, name: 'usage' }, { id: 21, name: 'usage' }] }]), REPO, NOW, CAPS);
    assert.deepEqual([res.aic, res.tasks], [30, null]);
  });

  it('reviewer runs count too: in flight → reserved at reviewer_agent + threat detection (600); unlistable → unknown', async () => {
    const res = await readSpendToday(world([], 200, [], 200, [{ id: 50 }]), REPO, NOW, CAPS);
    assert.deepEqual(today(res), { aic: 600, runs: [{ run_id: 50, status: 'reserved', aic: 600 }] });
    for (const status of [404, 500]) assert.equal((await readSpendToday(world([], 200, [], 200, [], status), REPO, NOW, CAPS)).aic, null, String(status));
  });

  it('repair runs count too: in flight → reserved at repair + threat detection (700); unlistable → unknown', async () => {
    const res = await readSpendToday(world([{ id: 1, status: 'in_progress' }], 200, [{ id: 40 }]), REPO, NOW, CAPS);
    assert.deepEqual(today(res), { aic: 1600, runs: [{ run_id: 1, status: 'reserved', aic: 900 }, { run_id: 40, status: 'reserved', aic: 700 }] });
    for (const status of [404, 500]) assert.equal((await readSpendToday(world([], 200, [], status), REPO, NOW, CAPS)).aic, null, String(status));
  });

  it('a re-run counts its full reservation for every attempt (an upper bound), completed or not, and by task', async () => {
    // implement + threat detection = 900 per attempt.
    for (const status of ['completed', 'queued', 'in_progress']) {
      const res = await readSpendToday(world([{ id: 9, attempt: 2, status, title: 'Implement en/a #3 attempt 1' }, { id: 8, attempt: 3, status }]), REPO, NOW, CAPS);
      assert.equal(res.aic, 1800 + 2700, status);
      assert.deepEqual(
        [...res.runs].sort((a, b) => a.run_id - b.run_id),
        [
          { run_id: 8, status: 'reserved', aic: 2700 },
          { run_id: 9, status: 'reserved', aic: 1800 },
        ],
        status,
      );
      assert.equal(res.tasks?.by_task['en/a'], 1800, status);
    }
    // A repair re-run (drill D1's case): repair + threat detection = 700 per attempt.
    const rep = await readSpendToday(world([], 200, [{ id: 40, status: 'completed', attempt: 2 }]), REPO, NOW, CAPS);
    assert.deepEqual(today(rep), { aic: 1400, runs: [{ run_id: 40, status: 'reserved', aic: 1400 }] });
  });

  it('a queued or in-progress run is reserved at the per-run caps (implement + threat detection)', async () => {
    const res = await readSpendToday(world([{ id: 1, status: 'in_progress' }, { id: 2, status: 'queued' }]), REPO, NOW, CAPS);
    assert.deepEqual(today(res), { aic: 1800, runs: [{ run_id: 1, status: 'reserved', aic: 900 }, { run_id: 2, status: 'reserved', aic: 900 }] });
  });

  it('a run still reported in progress whose jobs all completed, including conclusion, is measured (stale run status)', async () => {
    const gh = world([{ id: 9, status: 'in_progress', jobStatus: 'completed', conclusion: 'completed', detection: 'success', artifacts: [{ id: 90, name: 'usage' }], zips: { 90: usageZip(30, [2]) } }]);
    assert.deepEqual(today(await readSpendToday(gh, REPO, NOW, CAPS)), { aic: 32, runs: [{ run_id: 9, status: 'measured', aic: 32 }] });
  });

  it('stays reserved while any job is unfinished, the conclusion job is missing or unfinished, or the jobs can\'t be listed', async () => {
    const cases: FakeRun[] = [
      { id: 10, status: 'in_progress', jobStatus: 'in_progress', conclusion: 'queued' },
      { id: 11, status: 'in_progress', jobStatus: 'completed' },
      { id: 12, status: 'in_progress', jobStatus: 'completed', conclusion: 'in_progress' },
      { id: 13, status: 'queued', jobsStatus: 500 },
      { id: 14, status: 'in_progress', jobStatus: 'completed', conclusion: 'completed', agent: null, detection: null, jobsStatus: 404 },
    ];
    for (const c of cases) {
      assert.deepEqual(today(await readSpendToday(world([c]), REPO, NOW, CAPS)), { aic: 900, runs: [{ run_id: c.id, status: 'reserved', aic: 900 }] }, String(c.id));
    }
  });

  it('a finished-but-stale run whose usage can\'t be read is unknown, as for a completed run (fail closed)', async () => {
    const res = await readSpendToday(world([{ id: 15, status: 'in_progress', jobStatus: 'completed', conclusion: 'completed', artifacts: [] }]), REPO, NOW, CAPS);
    assert.equal(res.aic, null);
  });

  it('a completed run is measured from its usage artifact: agent ai_credits + detection responses', async () => {
    const gh = world([{ id: 3, detection: 'success', artifacts: [{ id: 30, name: 'usage' }, { id: 31, name: 'agent' }], zips: { 30: usageZip(123.456, [1.5, 0.25]) } }]);
    const res = await readSpendToday(gh, REPO, NOW, CAPS);
    assert.deepEqual(today(res), { aic: 125.206, runs: [{ run_id: 3, status: 'measured', aic: 125.206 }] });
    assert.ok(gh.calls.some((c) => c.path === `${r}/actions/artifacts/30/zip`));
  });

  it('a run whose Execute steps were skipped (e.g. validation failed) made no model calls → 0, without an artifact', async () => {
    const res = await readSpendToday(world([{ id: 4, agent: 'skipped' }, { id: 5, agent: null }]), REPO, NOW, CAPS);
    assert.deepEqual(today(res), { aic: 0, runs: [{ run_id: 4, status: 'no_inference', aic: 0 }, { run_id: 5, status: 'no_inference', aic: 0 }] });
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

  describe('a completed run whose usage is missing counts at its bound (revises #78 for completed runs only)', () => {
    const cases: [string, FakeRun, string][] = [
      ['no usage artifact', { id: 9 }, 'no_usage_artifact'],
      ['an expired usage artifact', { id: 9, artifacts: [{ id: 90, name: 'usage', expired: true }] }, 'usage_artifact_expired'],
      ['a usage artifact without agent_usage.json (drill D1: the token step failed)', { id: 9, detection: 'success', artifacts: [{ id: 90, name: 'usage' }], zips: { 90: usageZip(null, [3]) } }, 'usage_file_missing'],
    ];
    for (const [what, run, reason] of cases) {
      it(what, async () => {
        const res = await readSpendToday(world([{ ...run, title: 'Implement en/a #3 attempt 1' }]), REPO, NOW, CAPS);
        // implement 500 + threat detection 400: both hard stops per run in gh-aw.
        assert.deepEqual(today(res), { aic: 900, runs: [{ run_id: 9, status: 'bounded', aic: 900, reason }] });
        assert.equal(res.tasks?.by_task['en/a'], 900);
        assert.deepEqual(spendSnapshotFields('2026-10-16', res as unknown as { aic: number; runs: never[] }).runs, [{ run_id: 9, status: 'bounded', aic: 900, reason }], 'the audit event names it');
      });
    }

    it('a run not reported completed (stale in progress, all jobs done) with no usage stays unknown', async () => {
      const res = await readSpendToday(world([{ id: 15, status: 'in_progress', jobStatus: 'completed', conclusion: 'completed', artifacts: [] }]), REPO, NOW, CAPS);
      assert.equal(res.aic, null);
    });

    it('a repair run counts at repair + detection (700); yesterday\'s missing usage no longer makes per-task spend unknown', async () => {
      const res = await readSpendToday(world([{ id: 9, created: '2026-10-15T20:00:00Z', title: 'Repair en/a #3 attempt 2' }]), REPO, NOW, CAPS);
      assert.equal(res.aic, 0, 'yesterday is not today');
      assert.equal(res.tasks?.by_task['en/a'], 900, 'the implement fixture lists it as an implement run: 500 + 400');
    });

    it('the bound is never below the actual usage when both are known (the real gh-aw artifact, and any usage within the caps)', () => {
      const real = runAIC(readZip(new Uint8Array(readFileSync(new URL('./fixtures/usage-artifact.zip', import.meta.url))), ['agent_usage.json', 'detection/token_usage.jsonl']), ['agent', 'detection']);
      assert.ok(real <= CAPS.implement + CAPS.threat_detection, String(real));
      // Any measured run is at most its two hard caps.
      for (const [agent, det] of [[0, 0], [500, 400], [499.99, 0.01], [12.5, 3.25]] as const) {
        const files = new Map([['agent_usage.json', JSON.stringify({ ai_credits: agent })], ['detection/token_usage.jsonl', JSON.stringify({ ai_credits_this_response: det })]]);
        assert.ok(runAIC(files, ['agent', 'detection']) <= CAPS.implement + CAPS.threat_detection);
      }
    });
  });

  describe('unreadable → unknown (fail closed: nothing is dispatched)', () => {
    const cases: [string, FakeRun[], RegExp][] = [
      ['two usage artifacts', [{ id: 9, artifacts: [{ id: 90, name: 'usage' }, { id: 91, name: 'usage' }] }], /2 usage artifacts/],
      ['a download error', [{ id: 9, artifacts: [{ id: 90, name: 'usage' }], zips: { 90: { status: 410 } } }], /could not be read/],
      ['detection ran without records', [{ id: 9, detection: 'success', artifacts: [{ id: 90, name: 'usage' }], zips: { 90: usageZip(5, []) } }], /recorded no usage/],
      ['a corrupt zip entry', [{ id: 9, artifacts: [{ id: 90, name: 'usage' }], zips: { 90: zip({ 'agent_usage.json': '{"ai_credits":5}' }, { corruptCrc: 'agent_usage.json' }) } }], /CRC/],
      ['an implausible attempt number', [{ id: 9, attempt: 11 }], /unexpected run_attempt \(11\)/],
      ['attempt 0', [{ id: 9, attempt: 0 }], /unexpected run_attempt \(0\)/],
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
