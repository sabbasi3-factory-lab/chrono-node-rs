import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { crc32, deflateRawSync } from 'node:zlib';
import { FakeGitHub } from '../fake.ts';
import { attributedTask, jobInferred, readSpendToday, readZip, responseStats, runAIC, runSpendFields, runSpendSources, spendSnapshotFields, UsageMissing, type DispatchRecord, type LockVerifier } from '../spend.ts';
import { readFileSync } from 'node:fs';
import { NOW, REPO } from './helpers.ts';

const CAPS = { implement: 500, repair: 300, reviewer_agent: 200, factory_review: 500, threat_detection: 400 };
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
  /** updated_at (a completed run's end). */
  updated?: string;
  /** run_started_at (a re-run's latest attempt start). */
  started?: string;
  /** head_sha (default: a valid SHA; '' for none). */
  sha?: string;
}

function world(runs: FakeRun[], listStatus = 200, repairRuns: { id: number; status?: string; attempt?: number }[] = [], repairListStatus = 200, reviewRuns: { id: number; status?: string }[] = [], reviewListStatus = 200, triageRuns: { id: number; status?: string; title?: string }[] = [], triageListStatus = 200, improveRuns: { id: number; status?: string }[] = []): FakeGitHub {
  const gh = new FakeGitHub(REPO);
  gh.addRoute('GET', new RegExp(`^${r}/actions/workflows/triage\\.lock\\.yml/runs$`), () =>
    triageListStatus === 200
      ? { data: { workflow_runs: triageRuns.map((x) => ({ id: x.id, status: x.status ?? 'in_progress', run_attempt: 1, created_at: '2026-10-16T08:00:00Z', display_title: x.title ?? 'Triage en/a #3' })) } }
      : { status: triageListStatus, data: null },
  );
  gh.addRoute('GET', new RegExp(`^${r}/actions/workflows/improve\\.lock\\.yml/runs$`), () => ({
    data: { workflow_runs: improveRuns.map((x) => ({ id: x.id, status: x.status ?? 'in_progress', run_attempt: 1, created_at: '2026-10-16T08:00:00Z', display_title: 'Factory review' })) },
  }));
  gh.addRoute('GET', new RegExp(`^${r}/actions/workflows/review\\.lock\\.yml/runs$`), () =>
    reviewListStatus === 200
      ? { data: { workflow_runs: reviewRuns.map((x) => ({ id: x.id, status: x.status ?? 'in_progress', run_attempt: 1, created_at: '2026-10-16T08:00:00Z' })) } }
      : { status: reviewListStatus, data: null },
  );
  gh.addRoute('GET', new RegExp(`^${r}/actions/workflows/repair\\.lock\\.yml/runs$`), () =>
    repairListStatus === 200
      ? { data: { workflow_runs: repairRuns.map((x) => ({ id: x.id, status: x.status ?? 'in_progress', run_attempt: x.attempt ?? 1, created_at: '2026-10-16T08:00:00Z', run_started_at: '2026-10-16T08:00:00Z', head_sha: 'b'.repeat(40) })) } }
      : { status: repairListStatus, data: null },
  );
  // Honours `created=>=<day>` like GitHub (an old run re-run today keeps its created_at).
  const since = (path: string) => decodeURIComponent(/[?&]created=([^&]+)/.exec(path)?.[1] ?? '').replace(/^>=/, '');
  gh.addRoute('GET', new RegExp(`^${r}/actions/workflows/implement\\.lock\\.yml/runs$`), (path) =>
    listStatus === 200
      ? { data: { workflow_runs: runs.filter((x) => (x.created ?? '2026-10-16T08:00:00Z').slice(0, 10) >= since(path)).map((x) => ({ id: x.id, status: x.status ?? 'completed', run_attempt: x.attempt ?? 1, created_at: x.created ?? '2026-10-16T08:00:00Z', run_started_at: x.started ?? x.created ?? '2026-10-16T08:00:00Z', ...(x.updated ? { updated_at: x.updated } : {}), head_sha: x.sha ?? 'a'.repeat(40), display_title: x.title ?? 'Implement one factory task' })) } }
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
    assert.equal(res.aic, 1437, 'today: 30 + 1400 + 7');
    assert.deepEqual(res.tasks, { by_task: { 'en/a': 35, 'en/b': 1400 }, unattributed: 7, unknown_tasks: [] });
  });

  it('finals: every finished run of today and yesterday (a run in flight at midnight included), never a reserved one', async () => {
    const res = await readSpendToday(
      world([
        { id: 1, title: 'Implement en/a #3 attempt 1', artifacts: [{ id: 10, name: 'usage' }], zips: { 10: usageZip(30) } },
        { id: 2, title: 'Implement en/a #3 attempt 1', created: '2026-10-15T23:58:00Z', artifacts: [{ id: 20, name: 'usage' }], zips: { 20: usageZip(5) } },
        { id: 3, title: 'Implement en/b #4 attempt 1', status: 'in_progress' },
        { id: 4, title: 'Implement one factory task', agent: 'skipped' },
        { id: 5, created: '2026-10-15T20:00:00Z', artifacts: [{ id: 50, name: 'usage' }, { id: 51, name: 'usage' }] },
      ]),
      REPO,
      NOW,
      CAPS,
    );
    assert.deepEqual(
      [...(res.finals ?? [])].sort((a, b) => a.run_id - b.run_id),
      [
        { run_id: 1, workflow: 'implement', task: 'en/a', created_at: '2026-10-16T08:00:00Z', status: 'measured', aic: 30 },
        { run_id: 2, workflow: 'implement', task: 'en/a', created_at: '2026-10-15T23:58:00Z', status: 'measured', aic: 5 },
        { run_id: 4, workflow: 'implement', task: null, created_at: '2026-10-16T08:00:00Z', status: 'no_inference', aic: 0 },
      ],
      'run 3 is still reserved and run 5 is unreadable: neither is final',
    );
    assert.deepEqual(runSpendFields(res.finals!.find((f) => f.run_id === 2)!), { run_id: 2, workflow: 'implement', task: 'en/a', created_at: '2026-10-15T23:58:00Z', status: 'measured', aic: 5 });
  });

  it('backfill: older finished runs without a run_spend go to finals only, up to max, within days, never twice', async () => {
    const runs: FakeRun[] = [
      { id: 1, title: 'Implement en/a #3 attempt 1', artifacts: [{ id: 10, name: 'usage' }], zips: { 10: usageZip(30) } },
      { id: 2, title: 'Implement en/b #4 attempt 1', created: '2026-10-13T23:58:00Z', artifacts: [{ id: 20, name: 'usage' }], zips: { 20: usageZip(5) } },
      { id: 3, title: 'Implement en/c #5 attempt 1', created: '2026-10-13T10:00:00Z', artifacts: [{ id: 30, name: 'usage' }], zips: { 30: usageZip(6) } },
      { id: 4, title: 'Implement en/d #6 attempt 1', created: '2026-10-13T09:00:00Z', status: 'in_progress' },
      { id: 5, title: 'Implement en/e #7 attempt 1', created: '2026-10-05T09:00:00Z', artifacts: [{ id: 50, name: 'usage' }], zips: { 50: usageZip(7) } },
    ];
    const res = await readSpendToday(world(runs), REPO, NOW, CAPS, { backfill: { recorded: new Set([3]), days: 5, max: 5 } });
    assert.deepEqual(today(res), { aic: 30, runs: [{ run_id: 1, status: 'measured', aic: 30 }] }, 'today\'s total is unchanged');
    assert.deepEqual(res.tasks?.by_task, { 'en/a': 30 }, 'never a task\'s spend');
    assert.deepEqual(
      (res.finals ?? []).map((f) => [f.run_id, f.task, f.aic]).sort(),
      [[1, 'en/a', 30], [2, 'en/b', 5]],
      'run 3 is on record, run 4 is in flight, run 5 is too old',
    );
    const capped = await readSpendToday(world(runs), REPO, NOW, CAPS, { backfill: { recorded: new Set(), days: 5, max: 1 } });
    assert.equal((capped.finals ?? []).filter((f) => f.run_id !== 1).length, 1);
    const none = await readSpendToday(world(runs), REPO, NOW, CAPS);
    assert.deepEqual((none.finals ?? []).map((f) => f.run_id), [1]);
  });

  it('backfill rotates by read: runs that stay unreadable never starve the rest', async () => {
    const bad = (id: number): FakeRun => ({ id, created: '2026-10-13T10:00:00Z', artifacts: [{ id: id * 10, name: 'usage' }, { id: id * 10 + 1, name: 'usage' }] });
    const good: FakeRun = { id: 9, created: '2026-10-13T11:00:00Z', artifacts: [{ id: 90, name: 'usage' }], zips: { 90: usageZip(4) } };
    const runs = [bad(2), bad(3), good];
    const seen = new Set<number>();
    for (let poll = 0; poll < 3; poll++) {
      const res = await readSpendToday(world(runs), REPO, new Date(NOW.getTime() + poll * 300_000), CAPS, { backfill: { recorded: new Set(), days: 5, max: 1 } });
      for (const f of res.finals ?? []) seen.add(f.run_id);
    }
    assert.deepEqual([...seen], [9], 'the readable run is reached within one rotation');
  });

  it('run_spend sources: a bounded run\'s corrected evidence is a new event', () => {
    const f = { run_id: 7, workflow: 'implement' as const, task: 'en/a', created_at: '2026-10-16T08:00:00Z', status: 'bounded' as const, aic: 2600, reason: 'usage_file_missing' as const };
    assert.notDeepEqual(runSpendSources(f), runSpendSources({ ...f, readable_aic: 22.5 }));
    assert.notDeepEqual(runSpendSources({ ...f, observed_aic: 21 }), runSpendSources({ ...f, observed_aic: 46 }));
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

  it('factory review (improve) runs count toward today\'s total (factory_review + detection = 900), never toward a task', async () => {
    const res = await readSpendToday(world([], 200, [], 200, [], 200, [], 200, [{ id: 70 }]), REPO, NOW, CAPS);
    assert.deepEqual(today(res), { aic: 900, runs: [{ run_id: 70, status: 'reserved', aic: 900 }] });
    assert.deepEqual(res.tasks, { by_task: {}, unattributed: 0, unknown_tasks: [] });
  });

  it('an unreadable factory review run from yesterday leaves every task\'s spend known', async () => {
    const gh = world([], 200, [], 200, [], 200, []);
    gh.routes.unshift({ method: 'GET', path: new RegExp(`^/repos/${REPO}/actions/workflows/improve\\.lock\\.yml/runs$`), handler: () => ({ data: { workflow_runs: [{ id: 71, status: 'completed', run_attempt: 2, created_at: '2026-10-15T08:00:00Z', run_started_at: '2026-10-15T09:00:00Z', display_title: 'Factory review' }] } }) });
    const res = await readSpendToday(gh, REPO, NOW, CAPS);
    assert.deepEqual([res.aic, res.tasks], [0, { by_task: {}, unattributed: 0, unknown_tasks: [] }]);
  });

  it('triage runs always count (even with its cap gone from the policy) and against their own task only', async () => {
    // Off (no per_run.needs_human_triage): a run started before still counts, reserved at the reviewer's cap.
    const off = await readSpendToday(world([], 200, [], 200, [], 200, [{ id: 70 }]), REPO, NOW, CAPS);
    assert.deepEqual(today(off), { aic: 600, runs: [{ run_id: 70, status: 'reserved', aic: 600 }] });
    assert.deepEqual(off.tasks, { by_task: { 'en/a': 600 }, unattributed: 0, unknown_tasks: [] });
    const on = await readSpendToday(world([], 200, [], 200, [], 200, [{ id: 71, title: 'Triage en/b #4' }]), REPO, NOW, { ...CAPS, needs_human_triage: 150 });
    assert.deepEqual(today(on), { aic: 550, runs: [{ run_id: 71, status: 'reserved', aic: 550 }] });
    assert.deepEqual(on.tasks?.by_task, { 'en/b': 550 });
    for (const status of [404, 500]) assert.equal((await readSpendToday(world([], 200, [], 200, [], 200, [], status), REPO, NOW, CAPS)).aic, null, String(status));
  });

  it('attributedTask: a triage run matches its recorded triage dispatch (task and issue, within the window)', () => {
    const run = { display_title: 'Triage en/a #3', created_at: '2026-10-16T08:05:00Z' };
    assert.equal(attributedTask(run, [{ kind: 'triage', task: 'en/a', issue: 3, attempt: 0, at: '2026-10-16T08:00:00Z' }]), 'en/a');
    assert.equal(attributedTask(run, [{ kind: 'implement', task: 'en/a', issue: 3, attempt: 0, at: '2026-10-16T08:00:00Z' }]), null);
    assert.equal(attributedTask(run, [{ kind: 'triage', task: 'en/a', issue: 4, attempt: 0, at: '2026-10-16T08:00:00Z' }]), null);
  });

  it('repair runs count too: in flight → reserved at repair + threat detection (700); unlistable → unknown', async () => {
    const res = await readSpendToday(world([{ id: 1, status: 'in_progress' }], 200, [{ id: 40 }]), REPO, NOW, CAPS);
    assert.deepEqual(today(res), { aic: 2100, runs: [{ run_id: 1, status: 'reserved', aic: 1400 }, { run_id: 40, status: 'reserved', aic: 700 }] });
    for (const status of [404, 500]) assert.equal((await readSpendToday(world([], 200, [], status), REPO, NOW, CAPS)).aic, null, String(status));
  });

  it('a queued or in-progress run is reserved at the per-run caps (implement + threat detection + evals at implement\'s cap)', async () => {
    const res = await readSpendToday(world([{ id: 1, status: 'in_progress' }, { id: 2, status: 'queued' }]), REPO, NOW, CAPS);
    assert.deepEqual(today(res), { aic: 2800, runs: [{ run_id: 1, status: 'reserved', aic: 1400 }, { run_id: 2, status: 'reserved', aic: 1400 }] });
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
      assert.deepEqual(today(await readSpendToday(world([c]), REPO, NOW, CAPS)), { aic: 1400, runs: [{ run_id: c.id, status: 'reserved', aic: 1400 }] }, String(c.id));
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
    assert.equal(res.aic, 1440);
    assert.deepEqual(res.runs.map((x) => x.run_id), [6, 7]);
  });

  describe('the spend bound (budgets.yaml overshoot margin; revises #78 for completed runs only)', () => {
    // budgets.yaml (approved): margin 400 per AI job = max response 100 × max concurrency 4.
    const B = { margin: 400, max_response_aic: 100, max_concurrency: 4 };
    // implement: 500 + 400 (detection) + 500 (evals, inherits max-ai-credits) + 3 × 400 (agent, detection
    // and evals overshoot) = 2600.
    const IMPL_BOUND = 2600;
    const verified: LockVerifier = async () => true;
    const read = (runs: FakeRun[], bounding: typeof B | null = B, repair: { id: number; status?: string; attempt?: number }[] = [], verifyLock: LockVerifier | null = verified, dispatches: DispatchRecord[] = []) =>
      readSpendToday(world(runs, 200, repair), REPO, NOW, CAPS, { bounding, verifyLock, dispatches });
    /** agent/token_usage.jsonl records: [start offset s, duration s, AIC]. */
    const timed = (recs: [number, number, number][]) =>
      recs.map(([s, d, c], i) => JSON.stringify({ request_id: `a${i}`, timestamp: new Date(Date.parse('2026-10-16T08:00:00Z') + (s + d) * 1000).toISOString(), duration_ms: d * 1000, ai_credits_this_response: c })).join('\n') + '\n';
    const withRecords = (id: number, recs: [number, number, number][], agent = 30): FakeRun => ({
      id,
      artifacts: [{ id: id * 10, name: 'usage' }],
      zips: { [id * 10]: zip({ 'agent_usage.json': JSON.stringify({ ai_credits: agent }), 'agent/token_usage.jsonl': timed(recs) }) },
    });

    const missing: [string, FakeRun, string, { readable_aic?: number }?][] = [
      ['no usage artifact', { id: 9 }, 'no_usage_artifact'],
      ['an expired usage artifact', { id: 9, artifacts: [{ id: 90, name: 'usage', expired: true }] }, 'usage_artifact_expired'],
      ['a usage artifact without agent_usage.json (drill D1: the token step failed)', { id: 9, detection: 'success', artifacts: [{ id: 90, name: 'usage' }], zips: { 90: usageZip(null, [3]) } }, 'usage_file_missing', { readable_aic: 3 }],
      ['detection ran without records (#318: its engine never started)', { id: 9, detection: 'success', artifacts: [{ id: 90, name: 'usage' }], zips: { 90: usageZip(0, []) } }, 'usage_file_empty'],
    ];
    for (const [what, run, reason, extra = {}] of missing) {
      it(`completed, ${what} → counts at its bound (agent + detection + evals caps + 3 × margin), named in the audit event`, async () => {
        const res = await read([{ ...run, title: 'Implement en/a #3 attempt 1' }]);
        assert.deepEqual(today(res), { aic: IMPL_BOUND, runs: [{ run_id: 9, status: 'bounded', aic: IMPL_BOUND, reason, ...extra }] });
        assert.equal(res.tasks?.by_task['en/a'], IMPL_BOUND);
        assert.equal(res.alert, null);
        assert.deepEqual(spendSnapshotFields('2026-10-16', res as unknown as { aic: number; runs: never[] }).runs, [{ run_id: 9, status: 'bounded', aic: IMPL_BOUND, reason, ...extra }]);
      });
      it(`completed, ${what}, but no bound in force (no margin in the policy, or the locks differ) → unknown`, async () => {
        assert.equal((await read([run], null)).aic, null);
      });
    }

    it('an empty usage file keeps the readable total; above the bound it alerts and bounding is off (#338 review)', async () => {
      const empty = (agent: number): FakeRun => ({ id: 9, detection: 'success', title: 'Implement en/a #3 attempt 1', artifacts: [{ id: 90, name: 'usage' }], zips: { 90: usageZip(agent, []) } });
      const within = await read([empty(40)]);
      assert.deepEqual(within.runs, [{ run_id: 9, status: 'bounded', aic: IMPL_BOUND, reason: 'usage_file_empty', readable_aic: 40 }]);
      assert.equal(within.alert, null);
      const over = await read([empty(3000)]);
      assert.equal(over.aic, null, 'a bound the readable usage already exceeds is no bound');
      assert.deepEqual(over.alert, { code: 'overshoot_assumption_exceeded', run_id: 9, max_concurrency: 0, max_response_aic: 0, aic: 3000, bound: IMPL_BOUND });
    });

    it('a bounded run logs the agent artifact\'s own usage (informational, never counted)', async () => {
      const run: FakeRun = { id: 9, detection: 'success', artifacts: [{ id: 90, name: 'usage' }, { id: 91, name: 'agent' }], zips: { 90: usageZip(null, [3]), 91: zip({ 'agent_usage.json': '{"ai_credits":14.26}' }) } };
      const res = await read([run]);
      assert.deepEqual(res.runs, [{ run_id: 9, status: 'bounded', aic: IMPL_BOUND, reason: 'usage_file_missing', readable_aic: 3, observed_aic: 14.26 }]);
    });

    it('a run not reported completed (stale in progress, all jobs done) with no usage stays unknown', async () => {
      assert.equal((await read([{ id: 15, status: 'in_progress', jobStatus: 'completed', conclusion: 'completed', artifacts: [] }])).aic, null);
    });

    it('a re-run counts n × its bound, completed or not, and by task; without a bound it is unknown', async () => {
      for (const status of ['completed', 'queued', 'in_progress']) {
        const res = await read([{ id: 9, attempt: 2, status, title: 'Implement en/a #3 attempt 1' }, { id: 8, attempt: 3, status }]);
        assert.equal(res.aic, 2 * IMPL_BOUND + 3 * IMPL_BOUND, status);
        assert.deepEqual([...res.runs].sort((a, b) => a.run_id - b.run_id), [
          { run_id: 8, status: 'bounded', aic: 3 * IMPL_BOUND, reason: 'rerun' },
          { run_id: 9, status: 'bounded', aic: 2 * IMPL_BOUND, reason: 'rerun' },
        ], status);
        assert.equal(res.tasks?.by_task['en/a'], 2 * IMPL_BOUND);
        assert.match(String((await read([{ id: 9, attempt: 2, status }], null) as { reason?: string }).reason), /re-run \(attempt 2\) and no spend bound is in force/);
      }
      // Drill D1's case: a repair re-run, repair 300 + detection 400 + 800 = 1500 per attempt.
      const rep = await read([], B, [{ id: 40, status: 'completed', attempt: 2 }]);
      assert.deepEqual(today(rep), { aic: 3000, runs: [{ run_id: 40, status: 'bounded', aic: 3000, reason: 'rerun' }] });
    });

    it('a re-run of a run created yesterday counts in today\'s total when its attempt started today', async () => {
      const res = await read([{ id: 7, attempt: 2, created: '2026-10-15T23:30:00Z', started: '2026-10-16T01:00:00Z' }]);
      assert.equal(res.aic, 2 * IMPL_BOUND);
      const stale = await read([{ id: 7, attempt: 2, created: '2026-10-15T23:30:00Z', started: '2026-10-15T23:40:00Z' }]);
      assert.equal(stale.aic, 0, 'started yesterday: yesterday\'s');
    });

    describe('readable runs are checked against the assumptions; any excess turns the bound off and raises an alert', () => {
      const bounded: FakeRun = { id: 9, title: 'Implement en/a #3 attempt 1' };
      it('within the assumptions (4 overlapping requests, a 100 AIC response) → the bound stands, no alert', async () => {
        const ok = withRecords(5, [[0, 10, 100], [1, 10, 1], [2, 10, 1], [3, 10, 1], [20, 5, 2]], 105);
        const res = await read([bounded, ok]);
        assert.equal(res.alert, null);
        assert.equal(res.aic, IMPL_BOUND + 105);
        assert.deepEqual(res.runs.find((r) => r.run_id === 5), { run_id: 5, status: 'measured', aic: 105, max_concurrency: 4, max_response_aic: 100, responses_aic: 105 });
      });
      const breaches: [string, FakeRun, Partial<Record<string, number>>][] = [
        ['5 requests in flight at once', withRecords(5, [[0, 10, 1], [1, 10, 1], [2, 10, 1], [3, 10, 1], [4, 10, 1]], 5), { max_concurrency: 5 }],
        ['a single response above 100 AIC', withRecords(5, [[0, 10, 100.5]], 100.5), { max_response_aic: 100.5 }],
        ['a total above its bound', withRecords(5, [[0, 10, 1]], 2600.5), { aic: 2600.5 }],
      ];
      for (const [what, run, seen] of breaches) {
        it(`${what} → bound off (the bounded run makes spend unknown) and an alert`, async () => {
          const res = await read([bounded, run]);
          assert.equal(res.aic, null);
          assert.match((res as { reason: string }).reason, /broke an overshoot assumption: bounding is off/);
          assert.equal(res.alert?.code, 'overshoot_assumption_exceeded');
          assert.equal(res.alert?.run_id, 5);
          for (const [k, v] of Object.entries(seen)) assert.equal((res.alert as unknown as Record<string, number>)[k], v, k);
          // With nothing bounded, spend stays known, but the alert is still raised.
          const alone = await read([run]);
          assert.notEqual(alone.aic, null);
          assert.equal(alone.alert?.code, 'overshoot_assumption_exceeded');
        });
      }
    });

    it('the bound is never below the actual usage when the assumptions hold', () => {
      // A job's spend is at most its cap + the responses admitted just under it: at most
      // max_concurrency of them, each at most max_response_aic, i.e. at most cap + margin.
      for (const [cap, detection] of [[500, 400], [300, 400], [200, 400]] as const) {
        const worstAgent = cap + B.max_concurrency * B.max_response_aic;
        const worstDetection = detection + B.max_concurrency * B.max_response_aic;
        assert.ok(worstAgent + worstDetection <= cap + detection + 2 * B.margin);
      }
      const real = runAIC(readZip(new Uint8Array(readFileSync(new URL('./fixtures/usage-artifact.zip', import.meta.url))), ['agent_usage.json', 'detection/token_usage.jsonl']), ['agent', 'detection']);
      assert.ok(real <= IMPL_BOUND, String(real));
    });

    it('the bound applies only to a run whose own commit\'s workflow is verified (head_sha, caps)', async () => {
      const calls: string[] = [];
      const spy: LockVerifier = async (file, sha) => {
        calls.push(`${file}@${sha}`);
        return false;
      };
      assert.equal((await read([{ id: 9 }], B, [], spy)).aic, null, 'unverified commit → unknown');
      assert.equal((await read([{ id: 9, attempt: 2 }], B, [], spy)).aic, null, 'unverified re-run → unknown');
      assert.deepEqual(calls, [`implement.lock.yml@${'a'.repeat(40)}`, `implement.lock.yml@${'a'.repeat(40)}`]);
      assert.equal((await read([{ id: 9, sha: '' }])).aic, null, 'no head_sha → unknown');
      assert.equal((await read([{ id: 9 }], B, [], async () => {
        throw new Error('contents API down');
      })).aic, null, 'a verifier error → unknown');
    });

    it('in flight under a bound: reserved at the bound (the daily total carries the worst case)', async () => {
      assert.deepEqual(today(await read([{ id: 1, status: 'in_progress' }])), { aic: IMPL_BOUND, runs: [{ run_id: 1, status: 'reserved', aic: IMPL_BOUND }] });
    });

    it('a re-run of a run created days ago (within the re-run horizon) counts today when its attempt started today', async () => {
      const res = await read([{ id: 7, attempt: 2, created: '2026-10-11T09:00:00Z', started: '2026-10-16T02:00:00Z' }]);
      assert.equal(res.aic, 2 * IMPL_BOUND);
      const old = await read([{ id: 7, attempt: 1, created: '2026-10-11T09:00:00Z' }]);
      assert.equal(old.aic, 0, 'an old first attempt is not counted');
    });

    it('a readable run whose usage records can\'t be checked (no timings, or a job without records) → bound off and an overshoot_unverifiable alert', async () => {
      const noTimings: FakeRun = { id: 5, artifacts: [{ id: 50, name: 'usage' }], zips: { 50: zip({ 'agent_usage.json': '{"ai_credits":3}', 'agent/token_usage.jsonl': '{"ai_credits_this_response":3}\n' }) } };
      const noAgentRecords: FakeRun = { id: 5, artifacts: [{ id: 50, name: 'usage' }], zips: { 50: zip({ 'agent_usage.json': '{"ai_credits":3}' }) } };
      for (const run of [noTimings, noAgentRecords]) {
        const res = await read([{ id: 9 }, run]);
        assert.equal(res.aic, null);
        assert.equal(res.alert?.code, 'overshoot_unverifiable');
        assert.equal(res.alert?.run_id, 5);
      }
    });

    describe('Copilot review regressions', () => {
      it('missing agent usage with MALFORMED detection usage → unknown, not bounded (validated first, whatever the job order)', async () => {
        const run: FakeRun = { id: 9, detection: 'success', artifacts: [{ id: 90, name: 'usage' }], zips: { 90: zip({ 'detection/token_usage.jsonl': '{"x":1}\n' }) } };
        const res = await read([run]);
        assert.equal(res.aic, null);
        assert.match((res as { reason: string }).reason, /ai_credits_this_response/);
      });
      it('a re-run whose readable attempt shows a 150 AIC response → bound off and an alert (still n × bound if within)', async () => {
        const big: FakeRun = { id: 9, attempt: 2, artifacts: [{ id: 90, name: 'usage' }], zips: { 90: zip({ 'agent/token_usage.jsonl': timed([[0, 10, 150]]) }) } };
        const res = await read([big]);
        assert.equal(res.aic, null);
        assert.equal(res.alert?.code, 'overshoot_assumption_exceeded');
        const fine: FakeRun = { id: 9, attempt: 2, artifacts: [{ id: 90, name: 'usage' }], zips: { 90: zip({ 'agent/token_usage.jsonl': timed([[0, 10, 10]]) }) } };
        assert.deepEqual((await read([fine])).runs, [{ run_id: 9, status: 'bounded', aic: 2 * IMPL_BOUND, reason: 'rerun', max_concurrency: 1, max_response_aic: 10, responses_aic: 10 }]);
      });
      it('agent_usage.json missing but its per-response records show a 2000 AIC response → bound off and an alert', async () => {
        const run: FakeRun = { id: 9, artifacts: [{ id: 90, name: 'usage' }], zips: { 90: zip({ 'agent/token_usage.jsonl': timed([[0, 10, 2000]]) }) } };
        const res = await read([run]);
        assert.equal(res.aic, null);
        assert.equal(res.alert?.code, 'overshoot_assumption_exceeded');
        assert.equal(res.alert?.max_response_aic, 2000);
      });
      it('in flight under a bound: reserved at the bound only for a verified commit, else unknown', async () => {
        assert.equal((await read([{ id: 1, status: 'in_progress' }], B, [], async () => false)).aic, null);
        assert.equal((await read([{ id: 1, status: 'in_progress' }], null, [], async () => false)).aic, 1400, 'no bound: the caps, as before');
      });
      it('an EMPTY agent record file next to valid detection records → unverifiable (alert), not detection-only stats', async () => {
        const run: FakeRun = { id: 5, detection: 'success', artifacts: [{ id: 50, name: 'usage' }], zips: { 50: zip({ 'agent_usage.json': '{"ai_credits":3}', 'agent/token_usage.jsonl': '\n', 'detection/token_usage.jsonl': timed([[0, 1, 1]]) }) } };
        const res = await read([{ id: 9 }, run]);
        assert.equal(res.alert?.code, 'overshoot_unverifiable');
      });
    });

    it('responseStats: overlapping requests, back-to-back is not concurrent, unreadable → null', () => {
      const f = (t: string) => new Map([['agent/token_usage.jsonl', t]]);
      assert.deepEqual(responseStats(f(timed([[0, 10, 1], [5, 10, 2], [7, 1, 3]]))), { max_concurrency: 3, max_response_aic: 3, responses_aic: 6 });
      assert.deepEqual(responseStats(f(timed([[0, 10, 1], [10, 10, 2]]))), { max_concurrency: 1, max_response_aic: 2, responses_aic: 3 });
      assert.equal(responseStats(f('{"ai_credits_this_response":1}\n')), null, 'no timestamp');
      assert.equal(responseStats(f('not json\n')), null);
      assert.equal(responseStats(new Map()), null);
      // A gh-aw v1.2 evals record has no duration: it counts toward the largest response and the total, not concurrency.
      const withEvals = new Map([['agent/token_usage.jsonl', timed([[0, 10, 1], [5, 10, 2]])], ['evals/token_usage.jsonl', '{"input_tokens":1,"output_tokens":1,"ai_credits":4,"timestamp":"2026-11-10T00:00:00Z"}\n']]);
      assert.deepEqual(responseStats(withEvals, ['agent', 'evals']), { max_concurrency: 2, max_response_aic: 4, responses_aic: 7 });
      assert.equal(responseStats(new Map([['evals/token_usage.jsonl', '{"input_tokens":1,"output_tokens":1,"ai_credits":4}\n']])), null, 'no timed record: concurrency unknown');
      assert.equal(responseStats(new Map([...withEvals, ['evals/token_usage.jsonl', '{"input_tokens":1,"output_tokens":1}\n']])), null, 'unpriced');
    });
  });

  describe('per-task: an unreadable run from yesterday makes only its own task unknown when the audit log shows its dispatch', () => {
    const at = (t: string) => t;
    const disp = (o: Partial<DispatchRecord> = {}): DispatchRecord => ({ kind: 'implement', task: 'en/a', issue: 3, attempt: 1, at: at('2026-10-15T19:55:00Z'), ...o });
    const unreadable: FakeRun = { id: 2, created: '2026-10-15T20:00:00Z', title: 'Implement en/a #3 attempt 1', artifacts: [{ id: 20, name: 'usage' }, { id: 21, name: 'usage' }] };
    const read = (dispatches: DispatchRecord[]) => readSpendToday(world([unreadable, { id: 1, artifacts: [{ id: 10, name: 'usage' }], zips: { 10: usageZip(30) }, title: 'Implement en/b #4 attempt 1' }]), REPO, NOW, CAPS, { dispatches });
    it('a matching dispatch record → only en/a unknown; en/b is known, today\'s total stands', async () => {
      const res = await read([disp()]);
      assert.equal(res.aic, 30);
      assert.deepEqual(res.tasks, { by_task: { 'en/b': 30 }, unattributed: 0, unknown_tasks: ['en/a'] });
    });
    it('a run NAMED for en/a with no matching dispatch → every task unknown (the name alone proves nothing)', async () => {
      for (const ds of [[], [disp({ task: 'en/b' })], [disp({ issue: 4 })], [disp({ attempt: 2 })], [disp({ kind: 'repair' })], [disp({ at: '2026-10-15T20:05:00Z' })], [disp({ at: '2026-10-15T19:00:00Z' })]]) {
        assert.equal((await read(ds)).tasks, null, JSON.stringify(ds));
      }
    });
    it('attributedTask matches kind, task, issue and attempt within the window after the record', () => {
      const run = { display_title: 'Repair en/a #3 attempt 2', created_at: '2026-10-15T20:00:00Z' };
      assert.equal(attributedTask(run, [disp({ kind: 'repair', attempt: 2 })]), 'en/a');
      assert.equal(attributedTask(run, [disp({ kind: 'repair', attempt: 2, at: '2026-10-15T19:29:59Z' })]), null, 'more than 30 min before');
      assert.equal(attributedTask({ ...run, display_title: 'Repair one factory PR' }, [disp({ kind: 'repair', attempt: 2 })]), null);
    });
  });

  it('counts every unreadable run of today (the control room says how many)', async () => {
    const res = await readSpendToday(world([{ id: 9, artifacts: [{ id: 90, name: 'usage' }, { id: 91, name: 'usage' }] }, { id: 8, artifacts: [{ id: 80, name: 'usage' }, { id: 81, name: 'usage' }] }]), REPO, NOW, CAPS);
    assert.equal(res.aic, null);
    assert.equal((res as { unreadable_runs?: number }).unreadable_runs, 2);
  });

  it('says when the earliest unreadable run of today ended (the dispatch banner\'s "since")', async () => {
    const res = await readSpendToday(world([
      { id: 9, updated: '2026-10-16T09:40:00Z', artifacts: [{ id: 90, name: 'usage' }, { id: 91, name: 'usage' }] },
      { id: 8, updated: '2026-10-16T08:43:10Z', artifacts: [{ id: 80, name: 'usage' }, { id: 81, name: 'usage' }] },
    ]), REPO, NOW, CAPS);
    assert.equal((res as { unreadable_since?: string }).unreadable_since, '2026-10-16T08:43:10Z');
    const noEnd = await readSpendToday(world([{ id: 9, started: '2026-10-16T07:30:00Z', artifacts: [{ id: 90, name: 'usage' }, { id: 91, name: 'usage' }] }]), REPO, NOW, CAPS);
    assert.equal(noEnd.aic, null);
    assert.equal((noEnd as { unreadable_since?: string }).unreadable_since, '2026-10-16T07:30:00Z', 'no end time: its start');
  });

  describe('unreadable → unknown (fail closed: nothing is dispatched)', () => {
    const cases: [string, FakeRun[], RegExp][] = [
      ['two usage artifacts', [{ id: 9, artifacts: [{ id: 90, name: 'usage' }, { id: 91, name: 'usage' }] }], /2 usage artifacts/],
      ['a download error', [{ id: 9, artifacts: [{ id: 90, name: 'usage' }], zips: { 90: { status: 410 } } }], /could not be read/],
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

  it('runAIC: gh-aw v1.2 evals records (Decisions API: `ai_credits`, absent without pricing)', () => {
    // run_evals.cjs (gh-aw-actions v1.2.2): one record per evals run, no ai_credits_this_response.
    const evals = '{"provider":"copilot","model":"gpt-6.1-sol","input_tokens":13449,"output_tokens":72,"cache_read_tokens":7925,"cache_write_tokens":0,"reasoning_tokens":0,"input_tokens_include_cache":true,"ai_credits":1.25605,"cost_usd":0.0125605,"timestamp":"2026-11-10T01:04:59.919Z"}\n';
    const files = new Map([['agent_usage.json', '{"ai_credits":2.5}'], ['evals/token_usage.jsonl', evals]]);
    assert.equal(runAIC(files, ['agent', 'evals']), 3.75605);
    // No pricing for the evals model: token counts, no AIC → missing usage (counted at the bound), never 0.
    const unpriced = new Map([['agent_usage.json', '{"ai_credits":2.5}'], ['evals/token_usage.jsonl', '{"provider":"copilot","model":"new-model","input_tokens":10,"output_tokens":2}\n']]);
    assert.throws(() => runAIC(unpriced, ['agent', 'evals']), (e: unknown) => e instanceof UsageMissing && e.code === 'usage_aic_unavailable' && e.readable_aic === 2.5);
    assert.throws(() => runAIC(new Map([['evals/token_usage.jsonl', '{"ai_credits":-1,"input_tokens":1,"output_tokens":1}\n']]), ['evals']), /invalid ai_credits/);
    assert.throws(() => runAIC(new Map([['evals/token_usage.jsonl', '{"ai_credits_this_response":"1"}\n']]), ['evals']), /invalid ai_credits_this_response/);
    assert.throws(() => runAIC(new Map([['evals/token_usage.jsonl', '[1]\n']]), ['evals']), /not a usage record/);
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
