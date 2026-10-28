import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { crc32 } from 'node:zlib';
import { AuditLog, assertSafePayload } from '../audit.ts';
import { canonicalize } from '../canonical.ts';
import { collect, listAgentRuns, parseCollectArgs, pool, resolveTrigger, type GhAw } from '../collect-outcomes.ts';
import { run as controllerRun } from '../main.ts';
import { fakeWorld } from './world.ts';
import { testPolicies } from './helpers.ts';
import { FakeGitHub } from '../fake.ts';
import {
  buildSnapshot,
  evaluationReason,
  ingestOutcomes,
  isDrill,
  isTarget,
  itemsFromGhAw,
  outcomesFields,
  outcomesRunIneligible,
  OUTCOMES_EVENT,
  previousRuns,
  referencedNumbers,
  runRecord,
  selectRuns,
  summarize,
  taskFromPr,
  taskFromTitle,
  validateSnapshot,
  MAX_RUNS,
  MAX_SNAPSHOT_BYTES,
  OutcomesInvalid,
  type ListedRun,
  type OutcomeItem,
  type OutcomeRun,
} from '../outcomes.ts';
import { NOW, REPO } from './helpers.ts';

const r = `/repos/${REPO}`;
const PR_URL = (n: number): string => `https://github.com/${REPO}/pull/${n}`;
const DAY = 86_400_000;
const ago = (days: number): string => new Date(NOW.getTime() - days * DAY).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** A stored (uncompressed) ZIP with these files. */
function zip(files: Record<string, string>): Uint8Array {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8');
    const n = Buffer.from(name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(crc32(data), 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(crc32(data), 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, data);
    central.push(ch, n);
    offset += 30 + n.length + data.length;
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

const item = (over: Partial<OutcomeItem> = {}): OutcomeItem => ({ type: 'create_pull_request', object_url: PR_URL(54), outcome_status: 'accepted', evidence_strength: 'strong', zero_touch: true, ...over });
const listed = (id: number, over: Partial<ListedRun> = {}): ListedRun => ({ run_id: id, workflow: 'implement', title: 'Implement en/casual-date #7 attempt 1', created_at: ago(30), conclusion: 'success', ...over });
const record = (id: number, over: Partial<OutcomeRun> = {}): OutcomeRun => ({
  run_id: id,
  workflow: 'implement',
  task: 'en/casual-date',
  drill: false,
  created_at: ago(30),
  aic: 12.5,
  conclusion: 'success',
  eval: 'ok',
  evaluated_at: ago(1),
  items: [item()],
  ...over,
});
const snapshotText = (runs: OutcomeRun[], mutate?: (s: Record<string, unknown>) => void): string => {
  const s = JSON.parse(JSON.stringify(buildSnapshot(REPO, NOW, 'full', runs))) as Record<string, unknown>;
  mutate?.(s);
  return JSON.stringify(s);
};

describe('outcomes: task join', () => {
  it('takes the task from implement and repair run titles', () => {
    assert.equal(taskFromTitle('Implement common/iso-format-parser #29 attempt 1'), 'common/iso-format-parser');
    assert.equal(taskFromTitle('Repair drill/repair-ok #93 attempt 2'), 'drill/repair-ok');
    assert.equal(taskFromTitle('Implement one factory task'), null);
    assert.equal(taskFromTitle('Review one factory PR'), null);
    assert.equal(taskFromTitle('Implement Bad Task #1 attempt 1'), null);
    assert.equal(taskFromTitle(null), null);
  });

  it('falls back to the PR trailer, then the factory PR title', () => {
    assert.equal(taskFromPr({ title: 'anything', body: 'text\n\nFactory-Task: en/casual-date\nContract-SHA: abcdef1' }), 'en/casual-date');
    assert.equal(taskFromPr({ title: '[factory] common/forward-date-refiner: port ForwardDateRefiner', body: 'no trailers' }), 'common/forward-date-refiner');
    assert.equal(taskFromPr({ title: 'Some human PR', body: null }), null);
    // Conflicting trailers are ignored (parsePrTrailers), then the title decides.
    assert.equal(taskFromPr({ title: '[factory] en/a: port A', body: 'Factory-Task: en/b\nFactory-Task: en/c' }), 'en/a');
  });

  it('marks drill tasks', () => {
    assert.equal(isDrill('drill/repair-ok'), true);
    assert.equal(isDrill('en/casual-date'), false);
    assert.equal(isDrill(null), false);
  });

  it('orders referenced PRs before issues, created PRs first', () => {
    const refs = referencedNumbers([
      item({ type: 'add_comment', object_url: `https://github.com/${REPO}/issues/45#issuecomment-1` }),
      item({ type: 'push_to_pull_request_branch', object_url: PR_URL(60) }),
      item({ type: 'create_pull_request', object_url: PR_URL(54) }),
      item({ type: 'create_check_run', object_url: null }),
    ]);
    assert.deepEqual(refs, [
      { kind: 'pull', number: 54 },
      { kind: 'pull', number: 60 },
      { kind: 'issues', number: 45 },
    ]);
  });

  it('collect: joins a title-less run to the task of the PR its items point at, and marks drills', async () => {
    const gh = new FakeGitHub(REPO);
    runsRoute(gh, {
      implement: [{ id: 101, display_title: 'Implement one factory task' }],
      review: [{ id: 102, display_title: 'Review one factory PR' }],
      repair: [{ id: 103, display_title: 'Repair drill/repair-ok #93 attempt 2' }],
    });
    gh.addRoute('GET', new RegExp(`^${r}/pulls/54$`), () => ({ data: { title: 'x', body: 'Factory-Task: en/casual-date\nContract-SHA: abcdef1' } }));
    const ghAw = fakeGhAw({
      101: [item()],
      102: [item({ type: 'create_check_run', object_url: null, outcome_status: 'unknown', evidence_strength: 'none', zero_touch: null })],
      103: [item({ type: 'push_to_pull_request_branch', object_url: PR_URL(99), outcome_status: 'rejected', zero_touch: null })],
    });
    const { snapshot } = await collect({ client: gh, repo: REPO, ghAw, now: NOW, full: false, workDir: 'w', log: () => {}, previous: null });
    const by = new Map(snapshot.runs.map((x) => [x.run_id, x]));
    assert.equal(by.get(101)!.task, 'en/casual-date');
    assert.equal(by.get(101)!.drill, false);
    assert.equal(by.get(102)!.task, null);
    assert.equal(by.get(103)!.task, 'drill/repair-ok');
    assert.equal(by.get(103)!.drill, true);
    assert.equal(snapshot.mode, 'full');
  });
});

describe('outcomes: run selection', () => {
  const prev = new Map<number, OutcomeRun>([
    [1, record(1)],
    [2, record(2, { items: [item({ outcome_status: 'pending' })] })],
    [3, record(3, { items: [item({ outcome_status: 'unknown', evidence_strength: 'none' })] })],
    [4, record(4, { created_at: ago(3) })],
    [5, record(5, { eval: 'stale' })],
    [6, record(6, { eval: 'error', evaluated_at: null, items: [] })],
  ]);
  const runs = [1, 2, 3, 4, 5, 6, 7].map((id) => listed(id, id === 4 ? { created_at: ago(3) } : {}));

  it('incremental: new, pending/unknown, recent and previously failed runs; carries the rest', () => {
    const sel = selectRuns(runs, prev, NOW, false);
    assert.equal(sel.mode, 'incremental');
    assert.deepEqual(sel.evaluate.map((x) => x.run_id), [2, 3, 4, 5, 6, 7]);
    assert.deepEqual(sel.carry.map((x) => x.run_id), [1]);
    assert.equal(evaluationReason(runs[6]!, undefined, NOW, false), 'new');
    assert.equal(evaluationReason(runs[1]!, prev.get(2), NOW, false), 'pending_or_unknown');
    assert.equal(evaluationReason(runs[3]!, prev.get(4), NOW, false), 'recent');
    assert.equal(evaluationReason(runs[4]!, prev.get(5), NOW, false), 'previous_stale');
    assert.equal(evaluationReason(runs[0]!, prev.get(1), NOW, false), null);
  });

  it('full (forced, or no previous snapshot) evaluates everything', () => {
    for (const sel of [selectRuns(runs, prev, NOW, true), selectRuns(runs, null, NOW, false)]) {
      assert.equal(sel.mode, 'full');
      assert.equal(sel.evaluate.length, runs.length);
      assert.equal(sel.carry.length, 0);
    }
  });

  it('a failed evaluation keeps the previous items as stale, or is an error without any', () => {
    const fail = { ok: false as const, error: 'timeout' };
    const stale = runRecord(listed(1), prev.get(1), fail, undefined, 'en/casual-date', ago(0));
    assert.equal(stale.eval, 'stale');
    assert.deepEqual(stale.items, prev.get(1)!.items);
    assert.equal(stale.evaluated_at, prev.get(1)!.evaluated_at);
    assert.equal(stale.aic, 12.5);
    const error = runRecord(listed(7), undefined, fail, null, null, ago(0));
    assert.equal(error.eval, 'error');
    assert.deepEqual(error.items, []);
    assert.equal(error.evaluated_at, null);
    // A run whose previous record was an error stays an error.
    assert.equal(runRecord(listed(6), prev.get(6), fail, null, null, ago(0)).eval, 'error');
    const carried = runRecord(listed(1), prev.get(1), undefined, undefined, 'en/casual-date', ago(0));
    assert.deepEqual(carried, prev.get(1));
  });

  it('collect: carries unchanged runs, never drops a failed one, and fetches aic only when missing', async () => {
    const gh = new FakeGitHub(REPO);
    runsRoute(gh, { implement: [{ id: 1 }, { id: 2 }, { id: 7 }, { id: 8 }], repair: [], review: [] });
    const previous = new Map<number, OutcomeRun>([
      [1, record(1)],
      [2, record(2, { items: [item({ outcome_status: 'pending' })], aic: null })],
    ]);
    const calls: string[][] = [];
    const ghAw: GhAw = async (args, opts) => {
      calls.push(args);
      if (args[0] === 'logs') {
        assert.deepEqual(opts.input!.trim().split('\n').sort(), ['2', '7', '8']);
        return JSON.stringify({ runs: [{ run_id: 2, aic: 3.5 }, { run_id: 7, aic: 22.56436 }] });
      }
      const id = Number(args[1]);
      if (id === 8) throw new Error('timed out');
      return JSON.stringify({ run_id: id, items: [item()], summary: {} });
    };
    const logs: string[] = [];
    const { snapshot, failures } = await collect({ client: gh, repo: REPO, ghAw, now: NOW, full: false, workDir: 'w', log: (l) => logs.push(l), previous });
    assert.deepEqual(calls.filter((c) => c[0] === 'outcomes').map((c) => c[1]).sort(), ['2', '7', '8']);
    const by = new Map(snapshot.runs.map((x) => [x.run_id, x]));
    assert.deepEqual(by.get(1), previous.get(1));
    assert.equal(by.get(2)!.aic, 3.5);
    assert.equal(by.get(2)!.items[0]!.outcome_status, 'accepted');
    assert.equal(by.get(7)!.aic, 22.56436);
    assert.equal(by.get(8)!.eval, 'error');
    assert.equal(by.get(8)!.aic, null);
    assert.deepEqual(failures, [{ run_id: 8, error: 'timed out' }]);
    assert.equal(snapshot.mode, 'incremental');
    assert.equal(snapshot.runs.length, 4);
  });

  it('pool runs at most `limit` at once', async () => {
    let open = 0;
    let max = 0;
    await pool([1, 2, 3, 4, 5, 6, 7, 8, 9], 4, async () => {
      open++;
      max = Math.max(max, open);
      await new Promise((res) => setTimeout(res, 2));
      open--;
    });
    assert.equal(max, 4);
  });

  it('lists only completed runs and refuses unexpected paths', async () => {
    const gh = new FakeGitHub(REPO);
    runsRoute(gh, { implement: [{ id: 1 }, { id: 2, status: 'in_progress', conclusion: null }], repair: [], review: [] });
    assert.deepEqual((await listAgentRuns(gh, REPO)).map((x) => x.run_id), [1]);
    const bad = new FakeGitHub(REPO);
    runsRoute(bad, { implement: [{ id: 1, path: '.github/workflows/ci.yml' }], repair: [], review: [] });
    await assert.rejects(listAgentRuns(bad, REPO), /unexpected path/);
  });

  it('parses the CLI flags', () => {
    assert.equal(parseCollectArgs(['--out', 'x.json'], { OUTCOMES_FULL: 'true' }).full, true);
    assert.equal(parseCollectArgs(['--out', 'x.json'], { OUTCOMES_FULL: 'TRUE' }).full, false);
    assert.throws(() => parseCollectArgs([], {}), /--out/);
    assert.throws(() => parseCollectArgs(['--out', 'x', '--concurrency', '0'], {}), /concurrency/);
  });
});

describe('outcomes: targeted triggers', () => {
  const pend = (pr: number): OutcomeItem[] => [item({ object_url: PR_URL(pr), outcome_status: 'pending', zero_touch: null })];
  const prev = new Map<number, OutcomeRun>([
    [10, record(10, { created_at: ago(2), items: pend(54) })],
    [11, record(11, { workflow: 'repair', created_at: ago(1), items: [item({ type: 'push_to_pull_request_branch', object_url: PR_URL(54), outcome_status: 'pending', zero_touch: null })] })],
    [12, record(12, { task: 'en/other', created_at: ago(1), items: pend(60) })],
    [13, record(13, { task: 'en/old', created_at: ago(40), items: pend(20) })],
    [14, record(14, { task: 'en/done', created_at: ago(3), items: [item({ object_url: PR_URL(30) })] })],
    [15, record(15, { workflow: 'review', task: null, created_at: ago(1), items: [item({ type: 'create_check_run', object_url: null, outcome_status: 'unknown', evidence_strength: 'none', zero_touch: null })] })],
    [16, record(16, { task: 'en/later', created_at: ago(1), items: [] })],
  ]);
  const runs: ListedRun[] = [
    listed(10, { created_at: ago(2) }),
    listed(11, { workflow: 'repair', title: 'Repair en/casual-date #7 attempt 2', created_at: ago(1) }),
    listed(12, { title: 'Implement en/other #8 attempt 1', created_at: ago(1) }),
    listed(13, { title: 'Implement en/old #9 attempt 1', created_at: ago(40) }),
    listed(14, { title: 'Implement en/done #3 attempt 1', created_at: ago(3) }),
    listed(15, { workflow: 'review', title: 'Review one factory PR', created_at: ago(1) }),
    listed(16, { title: 'Implement en/later #5 attempt 1', created_at: ago(1) }),
    listed(17, { title: 'Implement en/casual-date #7 attempt 3', created_at: ago(0) }),
  ];

  it('pr: that PR\'s runs (by item URL or task) plus recent open runs and new runs; the rest carried', () => {
    const sel = selectRuns(runs, prev, NOW, false, { kind: 'pr', pr: 54, task: 'en/casual-date' });
    assert.equal(sel.mode, 'targeted');
    // 10, 11: point at PR 54; 17: new (also the PR's task); 12, 15: recent and still pending/unknown.
    assert.deepEqual(sel.evaluate.map((x) => x.run_id), [10, 11, 12, 15, 17]);
    // 13: pending but older than 14 days (the daily sweep re-checks it); 14, 16: settled.
    assert.deepEqual(sel.carry.map((x) => x.run_id), [13, 14, 16]);
    assert.equal(isTarget(runs[1]!, prev.get(11), { kind: 'pr', pr: 54, task: null }), true);
    assert.equal(isTarget(runs[6]!, prev.get(16), { kind: 'pr', pr: 99, task: 'en/later' }), true, 'joined by the PR task');
    assert.equal(isTarget(runs[5]!, prev.get(15), { kind: 'pr', pr: 99, task: null }), false);
  });

  it('run: that run plus recent open and new runs', () => {
    const sel = selectRuns(runs, prev, NOW, false, { kind: 'run', run_id: 14 });
    assert.deepEqual(sel.evaluate.map((x) => x.run_id), [10, 11, 12, 14, 15, 17]);
  });

  it('a dropped intermediate trigger loses nothing: the next targeted run still picks up the pending run', () => {
    // PR 60's close trigger was replaced in the concurrency group by PR 54's: run 12 (PR 60) is
    // still pending in the previous snapshot, so PR 54's targeted run re-evaluates it as well.
    const sel = selectRuns(runs, prev, NOW, false, { kind: 'pr', pr: 54, task: 'en/casual-date' });
    assert.ok(sel.evaluate.some((x) => x.run_id === 12));
  });

  it('sweep: also older pending runs; no previous snapshot is always the backfill', () => {
    assert.deepEqual(selectRuns(runs, prev, NOW, false).evaluate.map((x) => x.run_id), [10, 11, 12, 13, 14, 15, 16, 17]);
    assert.equal(selectRuns(runs, null, NOW, false, { kind: 'run', run_id: 14 }).mode, 'full');
    assert.equal(selectRuns(runs, null, NOW, false, { kind: 'run', run_id: 14 }).evaluate.length, runs.length);
  });

  it('resolves the trigger from numbers only, reading the PR through the API', async () => {
    const gh = new FakeGitHub(REPO);
    gh.addRoute('GET', new RegExp(`^${r}/pulls/54$`), () => ({ data: { user: { login: 'sabbasi3-factory-agent[bot]' }, state: 'closed', title: '[factory] en/casual-date: port X', body: 'Factory-Task: en/casual-date' } }));
    gh.addRoute('GET', new RegExp(`^${r}/pulls/55$`), () => ({ data: { user: { login: 'someone' }, state: 'closed', title: 't', body: '' } }));
    assert.deepEqual(await resolveTrigger(gh, REPO, {}), { kind: 'sweep' });
    assert.deepEqual(await resolveTrigger(gh, REPO, { OUTCOMES_PR: '', OUTCOMES_RUN_ID: '' }), { kind: 'sweep' });
    assert.deepEqual(await resolveTrigger(gh, REPO, { OUTCOMES_RUN_ID: '40602104871' }), { kind: 'run', run_id: 40602104871 });
    assert.deepEqual(await resolveTrigger(gh, REPO, { OUTCOMES_PR: '54' }), { kind: 'pr', pr: 54, task: 'en/casual-date' });
    await assert.rejects(resolveTrigger(gh, REPO, { OUTCOMES_PR: '55' }), /not an agent PR/);
    await assert.rejects(resolveTrigger(gh, REPO, { OUTCOMES_PR: '54; rm -rf /' }), /not a PR number/);
    await assert.rejects(resolveTrigger(gh, REPO, { OUTCOMES_PR: '54', OUTCOMES_RUN_ID: '1' }), /exclusive/);
  });
});

describe('outcomes: PR merge to audit event (end to end on the fakes)', () => {
  it('PR closed -> targeted collector -> artifact -> controller poll (workflow_run event dropped) -> one outcomes_snapshot with the PR accepted', async () => {
    const policies = await testPolicies();
    const gh = fakeWorld();
    const closedAt = new Date(NOW.getTime() - 10 * 60_000);
    const collectorAt = new Date(closedAt.getTime() + 3 * 60_000);
    // Before: an earlier snapshot on the audit branch has run 501's PR #54 pending.
    const before = new AuditLog(gh, { repo: REPO, factoryVersion: 'a'.repeat(40) });
    await before.load(closedAt);
    const prevSnap = buildSnapshot(REPO, closedAt, 'full', [
      record(501, { created_at: ago(0.5), items: [item({ outcome_status: 'pending', evidence_strength: 'medium', zero_touch: null })] }),
      record(400, { task: 'en/settled', created_at: ago(30), items: [item({ object_url: PR_URL(30) })] }),
    ]);
    await before.append({ type: OUTCOMES_EVENT, source_ids: ['outcomes_run:800', 'attempt:1'], fields: outcomesFields(prevSnap, 800, 1), dry_run: false }, closedAt);

    // 1. PR #54 (agent, closed: merged) triggers the collector, targeted at it.
    gh.routes.unshift(
      { method: 'GET', path: new RegExp(`^${r}/pulls/54$`), handler: () => ({ data: { user: { login: 'sabbasi3-factory-agent[bot]' }, state: 'closed', merged_at: closedAt.toISOString(), title: '[factory] en/casual-date: port X', body: 'Factory-Task: en/casual-date\nContract-SHA: abcdef1' } }) },
    );
    runsRoute(gh, {
      implement: [
        { id: 501, display_title: 'Implement en/casual-date #7 attempt 1', created_at: ago(0.5) },
        { id: 400, display_title: 'Implement en/settled #3 attempt 1', created_at: ago(30) },
      ],
      repair: [],
      review: [],
    });
    gh.routes.unshift(gh.routes.pop()!);
    const trigger = await resolveTrigger(gh, REPO, { OUTCOMES_PR: '54' });
    const evaluated: string[] = [];
    const ghAw: GhAw = async (args) => {
      if (args[0] === 'logs') return JSON.stringify({ runs: [] });
      evaluated.push(args[1]!);
      return JSON.stringify({ run_id: Number(args[1]), items: [{ outcome_status: 'accepted', evidence_strength: 'strong', type: 'create_pull_request', object_url: PR_URL(54), zero_touch: true }] });
    };
    const { snapshot } = await collect({ client: gh, repo: REPO, ghAw, now: collectorAt, full: false, trigger, workDir: 'w', log: () => {} });
    assert.deepEqual(evaluated, ['501'], 'only the PR\'s run is evaluated; the settled run is carried over');
    assert.equal(snapshot.mode, 'targeted');
    assert.equal(snapshot.runs.length, 2, 'the snapshot stays complete');

    // 2. Its artifact, from an outcomes run on pull_request_target (head_branch: the PR's branch).
    const outcomesRunDone = new Date(collectorAt.getTime() + 60_000).toISOString();
    gh.routes.unshift(
      { method: 'GET', path: new RegExp(`^${r}/actions/workflows/outcomes\\.yml/runs$`), handler: () => ({ data: { workflow_runs: [{ id: 901, run_attempt: 1, status: 'completed', conclusion: 'success', path: '.github/workflows/outcomes.yml', head_branch: 'factory/en-casual-date', event: 'pull_request_target', repository: { full_name: REPO }, head_repository: { full_name: REPO }, updated_at: outcomesRunDone }] } }) },
      { method: 'GET', path: new RegExp(`^${r}/actions/runs/901/artifacts$`), handler: () => ({ data: { artifacts: [{ id: 91, name: 'outcomes', expired: false, size_in_bytes: 4096 }] } }) },
      { method: 'GET', path: new RegExp(`^${r}/actions/artifacts/91/zip$`), handler: () => ({ data: zip({ 'outcomes.json': JSON.stringify(snapshot) }) }) },
    );

    // 3. The controller's workflow_run event was dropped (replaced in its concurrency group); the
    //    next ordinary poll, 6 minutes after the outcomes run finished, ingests it.
    const poll = { client: gh, repo: REPO, policies, factoryVersion: 'f'.repeat(40), now: NOW, log: () => {}, forceDryRun: true, env: { GITHUB_RUN_ID: '5', GITHUB_EVENT_NAME: 'schedule' } };
    assert.ok(NOW.getTime() - closedAt.getTime() <= 10 * 60_000, 'within the 10-minute budget');
    const result = await controllerRun(poll);
    const events = result.appended.filter((e) => e.type === OUTCOMES_EVENT);
    assert.equal(events.length, 1);
    const p = events[0]!.payload;
    assert.equal(p.source_run_id, 901);
    assert.equal(p.mode, 'targeted');
    const run501 = (p.runs as unknown as OutcomeRun[]).find((x) => x.run_id === 501)!;
    assert.equal(run501.task, 'en/casual-date');
    assert.equal(run501.items[0]!.outcome_status, 'accepted');
    assert.equal(run501.items[0]!.object_url, PR_URL(54));

    // 4. A later poll (or the delayed workflow_run event) records nothing more.
    const again = await controllerRun({ ...poll, now: new Date(NOW.getTime() + 60_000), env: { GITHUB_RUN_ID: '6', GITHUB_EVENT_NAME: 'workflow_run' } });
    assert.equal(again.appended.filter((e) => e.type === OUTCOMES_EVENT).length, 0);
  });

  it('an ingest failure never blocks the poll', async () => {
    const policies = await testPolicies();
    const gh = fakeWorld();
    gh.routes.unshift({ method: 'GET', path: new RegExp(`^${r}/actions/workflows/outcomes\\.yml/runs$`), handler: () => ({ status: 500, data: null }) });
    const logs: string[] = [];
    const result = await controllerRun({ client: gh, repo: REPO, policies, factoryVersion: 'f'.repeat(40), now: NOW, log: (l) => logs.push(l), forceDryRun: true, env: { GITHUB_RUN_ID: '5', GITHUB_EVENT_NAME: 'schedule' } });
    assert.ok(logs.some((l) => /^outcomes: not ingested/.test(l)));
    assert.ok(result.appended.some((e) => e.type === 'heartbeat'), 'the poll went on');
  });
});

describe('outcomes: gh-aw output and snapshot building', () => {
  it('normalizes gh-aw items and nulls foreign object URLs', () => {
    const out = itemsFromGhAw(
      {
        run_id: 5,
        items: [
          { outcome_status: 'accepted', evidence_strength: 'strong', signal: 'merged', type: 'create_pull_request', object_url: PR_URL(54), object_number: 54, zero_touch: true, detail: 'merged' },
          { outcome_status: 'unknown', evidence_strength: 'none', type: 'create_check_run', detail: 'no object reference to check' },
          { outcome_status: 'pending', evidence_strength: 'medium', type: 'add_comment', object_url: 'https://github.com/other/repo/issues/1' },
        ],
      },
      5,
      REPO,
    );
    assert.deepEqual(out.items, [
      { type: 'create_pull_request', object_url: PR_URL(54), outcome_status: 'accepted', evidence_strength: 'strong', zero_touch: true },
      { type: 'create_check_run', object_url: null, outcome_status: 'unknown', evidence_strength: 'none', zero_touch: null },
      { type: 'add_comment', object_url: null, outcome_status: 'pending', evidence_strength: 'medium', zero_touch: null },
    ]);
    assert.equal(out.dropped_urls, 1);
    assert.throws(() => itemsFromGhAw({ run_id: 6, items: [] }, 5, REPO), /not 5/);
    assert.throws(() => itemsFromGhAw({ run_id: 5, items: [{ type: 'x', outcome_status: 'great', evidence_strength: 'strong' }] }, 5, REPO), /outcome_status/);
  });

  it('summarizes items once per item and aic once per run', () => {
    const runs = [
      record(1, { aic: 10, items: [item(), item({ outcome_status: 'pending', zero_touch: null })] }),
      record(2, { aic: null, items: [item({ outcome_status: 'lifecycle' })] }),
      record(3, { aic: 2.25, eval: 'stale', items: [] }),
      record(4, { aic: null, eval: 'error', evaluated_at: null, items: [] }),
    ];
    assert.deepEqual(summarize(runs), { runs: 4, items: 3, accepted: 1, rejected: 0, ignored: 0, pending: 1, unknown: 0, other: 1, zero_touch: 2, eval_stale: 1, eval_error: 1, aic: 12.25 });
  });

  it('builds a snapshot, newest run first, that its own validator accepts and the audit payload check passes', () => {
    const snap = buildSnapshot(REPO, NOW, 'incremental', [record(1), record(3, { task: 'drill/repair-ok', drill: true }), record(2)]);
    assert.deepEqual(snap.runs.map((x) => x.run_id), [3, 2, 1]);
    assert.deepEqual(validateSnapshot(JSON.stringify(snap), REPO), snap);
    const fields = outcomesFields(snap, 900, 1);
    assert.doesNotThrow(() => assertSafePayload(fields));
    assert.doesNotThrow(() => canonicalize(fields));
  });
});

describe('outcomes: ingest validator', () => {
  const good = [record(1), record(2, { workflow: 'review', task: null, items: [item({ type: 'create_check_run', object_url: null, outcome_status: 'unknown', evidence_strength: 'none', zero_touch: null })] })];
  const rejects = (text: string, re: RegExp): void => {
    assert.throws(() => validateSnapshot(text, REPO), (e: unknown) => e instanceof OutcomesInvalid && re.test((e as Error).message));
  };
  const runAt = (s: Record<string, unknown>, i = 0): Record<string, unknown> => (s.runs as Record<string, unknown>[])[i]!;
  const itemAt = (s: Record<string, unknown>): Record<string, unknown> => (runAt(s).items as Record<string, unknown>[])[0]!;

  it('accepts a good snapshot', () => {
    assert.equal(validateSnapshot(snapshotText(good), REPO).runs.length, 2);
  });

  it('rejects a bad enum', () => {
    rejects(snapshotText(good, (s) => (itemAt(s).outcome_status = 'merged')), /outcome_status/);
    rejects(snapshotText(good, (s) => (itemAt(s).evidence_strength = 'certain')), /evidence_strength/);
    rejects(snapshotText(good, (s) => (runAt(s).workflow = 'ci')), /workflow/);
    rejects(snapshotText(good, (s) => (runAt(s).eval = 'maybe')), /eval/);
    rejects(snapshotText(good, (s) => (s.mode = 'partial')), /mode/);
  });

  it('rejects bad URLs, including another repo', () => {
    rejects(snapshotText(good, (s) => (itemAt(s).object_url = 'https://github.com/sabbasi3-factory-lab/other/pull/1')), /object_url/);
    rejects(snapshotText(good, (s) => (itemAt(s).object_url = 'https://evil.example/pull/1')), /object_url/);
    rejects(snapshotText(good, (s) => (itemAt(s).object_url = `${PR_URL(1)}/files`)), /object_url/);
    rejects(snapshotText(good, (s) => (itemAt(s).object_url = `https://github.com/${REPO}/commit/abc`)), /object_url/);
    assert.doesNotThrow(() => validateSnapshot(snapshotText(good, (s) => (itemAt(s).object_url = `https://github.com/${REPO}/issues/45#issuecomment-6327754946`)), REPO));
  });

  it('rejects extra or missing keys at every level', () => {
    rejects(snapshotText(good, (s) => (s.extra = 1)), /snapshot: keys/);
    rejects(snapshotText(good, (s) => (runAt(s).title = 'free text')), /runs\[0\]: keys/);
    rejects(snapshotText(good, (s) => (itemAt(s).detail = 'merged')), /items\[0\]: keys/);
    rejects(snapshotText(good, (s) => delete (itemAt(s) as { zero_touch?: unknown }).zero_touch), /items\[0\]: keys/);
    rejects(snapshotText(good, (s) => ((s.summary as Record<string, unknown>).acceptance_rate = 1)), /summary: keys/);
  });

  it('rejects bad ids, tasks, aic, drill flags, timestamps, repo and summaries', () => {
    rejects(snapshotText(good, (s) => (runAt(s).run_id = '40602104871')), /run_id/);
    rejects(snapshotText(good, (s) => (runAt(s, 1).run_id = runAt(s).run_id)), /duplicate/);
    rejects(snapshotText(good, (s) => (runAt(s).task = 'Not A Task')), /task/);
    rejects(snapshotText(good, (s) => (runAt(s).aic = -1)), /aic/);
    rejects(snapshotText(good, (s) => (runAt(s).aic = '1')), /aic/);
    rejects(snapshotText(good, (s) => (runAt(s).drill = true)), /drill/);
    rejects(snapshotText(good, (s) => (runAt(s).created_at = '2026-10-16')), /created_at/);
    rejects(snapshotText(good, (s) => (s.repo = 'other/repo')), /repo/);
    rejects(snapshotText(good, (s) => ((s.summary as Record<string, unknown>).accepted = 99)), /summary: does not match/);
    rejects('not json', /not JSON/);
  });

  it('rejects oversize input and too many runs', () => {
    rejects(' '.repeat(MAX_SNAPSHOT_BYTES + 1), /larger than/);
    const many = Array.from({ length: MAX_RUNS + 1 }, (_, i) => record(i + 1, { items: [] }));
    rejects(snapshotText(many), /more than/);
  });
});

describe('outcomes: controller ingestion', () => {
  const outcomesRun = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 900,
    run_attempt: 1,
    status: 'completed',
    conclusion: 'success',
    path: '.github/workflows/outcomes.yml',
    head_branch: 'main',
    event: 'schedule',
    repository: { full_name: REPO },
    head_repository: { full_name: REPO },
    updated_at: ago(0.1),
    ...over,
  });

  function world(runs: Record<string, unknown>[], text = snapshotText([record(1), record(2, { task: 'drill/repair-ok', drill: true })])): FakeGitHub & { downloads: number } {
    const gh = new FakeGitHub(REPO) as FakeGitHub & { downloads: number };
    gh.downloads = 0;
    gh.addRoute('GET', new RegExp(`^${r}/actions/workflows/outcomes\\.yml/runs$`), () => ({ data: { workflow_runs: runs } }));
    gh.addRoute('GET', new RegExp(`^${r}/actions/runs/\\d+/artifacts$`), () => ({ data: { artifacts: [{ id: 77, name: 'outcomes', expired: false, size_in_bytes: 1000 }] } }));
    gh.addRoute('GET', new RegExp(`^${r}/actions/artifacts/77/zip$`), () => {
      gh.downloads++;
      return { data: zip({ 'outcomes.json': text }) };
    });
    return gh;
  }
  const load = async (gh: FakeGitHub): Promise<AuditLog> => {
    const audit = new AuditLog(gh, { repo: REPO, factoryVersion: 'a'.repeat(40) });
    await audit.load(NOW);
    return audit;
  };

  it('appends one outcomes_snapshot, real in both modes, and only once per outcomes run attempt', async () => {
    const gh = world([outcomesRun()]);
    for (const dryRun of [true, false]) {
      const audit = new AuditLog(gh, { repo: REPO, factoryVersion: 'a'.repeat(40), dryRun });
      await audit.load(NOW);
      await ingestOutcomes(gh, REPO, audit, NOW);
    }
    const audit = await load(gh);
    const events = audit.events.filter((e) => e.type === 'outcomes_snapshot');
    assert.equal(events.length, 1);
    const p = events[0]!.payload;
    assert.equal(p.dry_run, false);
    assert.equal(p.source_run_id, 900);
    assert.equal(p.source_run_attempt, 1);
    assert.equal(p.gh_aw_version, 'v0.92.0');
    assert.equal((p.runs as unknown[]).length, 2);
    assert.equal(gh.downloads, 1, 'a recorded run is not downloaded again');
    assert.deepEqual(await ingestOutcomes(gh, REPO, audit, NOW), { status: 'duplicate', run_id: 900 });
    // The collector reads it back as the previous snapshot.
    assert.deepEqual([...previousRuns(audit, REPO)!.keys()].sort(), [1, 2]);
    // A re-run attempt of the same outcomes run is a new evaluation (unchanged content: only a marker).
    const gh2 = world([outcomesRun({ run_attempt: 2 })]);
    for (const [k, v] of gh.refs) gh2.refs.set(k, v);
    for (const [k, v] of gh.commits) gh2.commits.set(k, v);
    for (const [k, v] of gh.trees) gh2.trees.set(k, v);
    for (const [k, v] of gh.blobs) gh2.blobs.set(k, v);
    assert.equal((await ingestOutcomes(gh2, REPO, await load(gh2), NOW)).status, 'unchanged');
  });

  describe('size guard: unchanged snapshots are not recorded again', () => {
    const base = [record(1), record(2, { items: [item({ outcome_status: 'pending', zero_touch: null })] })];
    /** Ingests outcomes run 900 (base), then run 901 with `next`; returns the audit events and 901's result. */
    async function twice(next: string): Promise<{ events: string[]; second: Awaited<ReturnType<typeof ingestOutcomes>>; downloads: number; audit: AuditLog; gh: FakeGitHub & { downloads: number } }> {
      let current = snapshotText(base);
      const gh = new FakeGitHub(REPO) as FakeGitHub & { downloads: number };
      gh.downloads = 0;
      let runs = [outcomesRun({ id: 900 })];
      gh.addRoute('GET', new RegExp(`^${r}/actions/workflows/outcomes\\.yml/runs$`), () => ({ data: { workflow_runs: runs } }));
      gh.addRoute('GET', new RegExp(`^${r}/actions/runs/\\d+/artifacts$`), () => ({ data: { artifacts: [{ id: 77, name: 'outcomes', expired: false, size_in_bytes: 1000 }] } }));
      gh.addRoute('GET', new RegExp(`^${r}/actions/artifacts/77/zip$`), () => {
        gh.downloads++;
        return { data: zip({ 'outcomes.json': current }) };
      });
      assert.equal((await ingestOutcomes(gh, REPO, await load(gh), NOW)).status, 'ingested');
      current = next;
      runs = [outcomesRun({ id: 901, event: 'workflow_run' })];
      const later = new Date(NOW.getTime() + 60_000);
      const audit = new AuditLog(gh, { repo: REPO, factoryVersion: 'a'.repeat(40) });
      await audit.load(later);
      const second = await ingestOutcomes(gh, REPO, audit, later);
      return { events: audit.events.map((e) => e.type), second, downloads: gh.downloads, audit, gh };
    }
    const withVolatile = (mutate: (s: Record<string, unknown>) => void): string => snapshotText(base, mutate);

    it('unchanged: no new snapshot, one tiny marker, and no further download', async () => {
      const t = await twice(snapshotText(base));
      assert.deepEqual(t.second, { status: 'unchanged', run_id: 901, same_as: 900 });
      assert.deepEqual(t.events, ['outcomes_snapshot', 'outcomes_checked']);
      const marker = t.audit.events[1]!;
      assert.ok(canonicalize(marker).length < 1000, `the marker is tiny (${canonicalize(marker).length} bytes)`);
      assert.equal(marker.payload.same_as_run_id, 900);
      // Later polls skip run 901 before downloading it.
      assert.deepEqual(await ingestOutcomes(t.gh, REPO, t.audit, new Date(NOW.getTime() + 120_000)), { status: 'duplicate', run_id: 901 });
      assert.equal(t.gh.downloads, 2);
    });

    it('volatile-only changes (evaluated_at, per-run evaluated_at, mode, source run): no new snapshot', async () => {
      const t = await twice(
        withVolatile((s) => {
          s.evaluated_at = ago(-0.01);
          s.mode = 'targeted';
          for (const run of s.runs as Record<string, unknown>[]) run.evaluated_at = ago(-0.01);
        }),
      );
      assert.equal(t.second.status, 'unchanged');
      assert.deepEqual(t.events, ['outcomes_snapshot', 'outcomes_checked']);
    });

    it('one item changes: one new snapshot', async () => {
      const changed = [record(1), record(2, { items: [item({ outcome_status: 'accepted', zero_touch: true })] })];
      const t = await twice(snapshotText(changed));
      assert.equal(t.second.status, 'ingested');
      assert.deepEqual(t.events, ['outcomes_snapshot', 'outcomes_snapshot']);
    });

    it('a new run, or a changed aic, is a change', async () => {
      assert.equal((await twice(snapshotText([...base, record(3)]))).second.status, 'ingested');
      assert.equal((await twice(snapshotText([record(1, { aic: 13 }), base[1]!]))).second.status, 'ingested');
    });
  });

  it('ingests the newest eligible run only', async () => {
    const gh = world([outcomesRun({ id: 950, path: '.github/workflows/other.yml' }), outcomesRun({ id: 940 }), outcomesRun({ id: 930 })]);
    assert.deepEqual(await ingestOutcomes(gh, REPO, await load(gh), NOW), { status: 'ingested', run_id: 940, runs: 2, items: 2 });
  });

  it('gates on workflow path, branch, event, repo, success and age', () => {
    assert.equal(outcomesRunIneligible(outcomesRun(), REPO, NOW), null);
    assert.equal(outcomesRunIneligible(outcomesRun({ event: 'workflow_dispatch' }), REPO, NOW), null);
    assert.equal(outcomesRunIneligible(outcomesRun({ event: 'workflow_run' }), REPO, NOW), null);
    // pull_request_target runs main's workflow; its head_branch is the PR's branch.
    assert.equal(outcomesRunIneligible(outcomesRun({ event: 'pull_request_target', head_branch: 'factory/en-casual-date' }), REPO, NOW), null);
    assert.equal(outcomesRunIneligible(outcomesRun({ event: 'push' }), REPO, NOW), 'wrong_event');
    assert.equal(outcomesRunIneligible(outcomesRun({ path: '.github/workflows/ci.yml' }), REPO, NOW), 'wrong_workflow_path');
    assert.equal(outcomesRunIneligible(outcomesRun({ head_branch: 'feature' }), REPO, NOW), 'wrong_branch');
    assert.equal(outcomesRunIneligible(outcomesRun({ event: 'pull_request' }), REPO, NOW), 'wrong_event');
    assert.equal(outcomesRunIneligible(outcomesRun({ head_repository: { full_name: 'fork/chrono-node-rs' } }), REPO, NOW), 'wrong_repo');
    assert.equal(outcomesRunIneligible(outcomesRun({ repository: { full_name: 'other/repo' } }), REPO, NOW), 'wrong_repo');
    assert.equal(outcomesRunIneligible(outcomesRun({ conclusion: 'failure' }), REPO, NOW), 'not_successful');
    assert.equal(outcomesRunIneligible(outcomesRun({ status: 'in_progress', conclusion: null }), REPO, NOW), 'not_successful');
    assert.equal(outcomesRunIneligible(outcomesRun({ updated_at: ago(4) }), REPO, NOW), 'too_old');
    assert.equal(outcomesRunIneligible(outcomesRun({ id: '900' }), REPO, NOW), 'no_run_id');
  });

  it('records nothing for an ineligible run, an invalid artifact or a missing workflow', async () => {
    for (const bad of [outcomesRun({ head_branch: 'feature' }), outcomesRun({ event: 'pull_request' }), outcomesRun({ path: '.github/workflows/x.yml' })]) {
      const gh = world([bad]);
      assert.deepEqual(await ingestOutcomes(gh, REPO, await load(gh), NOW), { status: 'none' });
      assert.equal(gh.downloads, 0);
    }
    const invalid = world([outcomesRun()], snapshotText([record(1)], (s) => (s.extra = true)));
    const audit = await load(invalid);
    await assert.rejects(ingestOutcomes(invalid, REPO, audit, NOW), OutcomesInvalid);
    assert.equal(audit.appended.length, 0);
    const none = new FakeGitHub(REPO);
    assert.deepEqual(await ingestOutcomes(none, REPO, await load(none), NOW), { status: 'none' });
  });
});

// ---------------------------------------------------------------- helpers

function runsRoute(gh: FakeGitHub, byWorkflow: Record<'implement' | 'repair' | 'review', Record<string, unknown>[]>): void {
  gh.addRoute('GET', new RegExp(`^${r}/actions/workflows/(implement|repair|review)\\.lock\\.yml/runs$`), (path) => {
    const wf = /workflows\/(\w+)\.lock\.yml/.exec(path)![1] as 'implement' | 'repair' | 'review';
    return {
      data: {
        workflow_runs: byWorkflow[wf].map((x) => ({
          path: `.github/workflows/${wf}.lock.yml`,
          status: 'completed',
          conclusion: 'success',
          created_at: ago(30),
          display_title: wf === 'review' ? 'Review one factory PR' : 'Implement one factory task',
          ...x,
        })),
      },
    };
  });
}

function fakeGhAw(items: Record<number, OutcomeItem[]>): GhAw {
  return async (args) => {
    if (args[0] === 'logs') return JSON.stringify({ runs: [] });
    const id = Number(args[1]);
    return JSON.stringify({ run_id: id, items: items[id] ?? [], summary: {} });
  };
}
