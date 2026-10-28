import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AuditLog, dedupeKey } from '../audit.ts';
import { collect, type GhAw } from '../collect-outcomes.ts';
import { DIAGNOSIS_EVENT, diagnosisComment, diagnosisMarker, pendingDiagnoses, postDiagnoses } from '../diagnosis.ts';
import { FakeGitHub } from '../fake.ts';
import { assertAllowedRequest } from '../github.ts';
import { diagnosisFromAudit, matchReviewRuns, needsDiagnosis, taskFromTitle, validateRuns, validateSnapshot, buildSnapshot, type OutcomeRun, type ReviewDispatch } from '../outcomes.ts';
import type { AuditEvent, IssueSnap } from '../types.ts';
import { NOW, REPO } from './helpers.ts';

const r = `/repos/${REPO}`;
const at = (min: number): string => new Date(NOW.getTime() + min * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const run = (id: number, over: Partial<OutcomeRun> = {}): OutcomeRun => ({
  run_id: id, workflow: 'implement', task: 'common/extract-timezone-abbr-refiner', drill: false, created_at: at(-60), aic: 10, conclusion: 'failure',
  eval: 'ok', evaluated_at: at(-1), items: [], diagnosis: null, ...over,
});
/** gh-aw audit --json for failed run 40552111692 (#26 attempt 1), trimmed to what is read. */
const AUDIT_26 = {
  key_findings: [
    { code: 'workflow_failed', category: 'error', severity: 'critical', title: 'Workflow Failed', description: "Workflow 'Implement …' failed with 1 error(s): free text" },
    { code: 'high_token_usage', category: 'performance', severity: 'medium', title: 'High Token Usage', description: 'Used 703k tokens' },
    { code: 'agentic_resource_heavy_for_domain', category: 'performance', severity: 'medium', title: 'Resource Heavy For Domain', description: '…' },
  ],
  agentic_assessments: [{ kind: 'resource_heavy_for_domain' }],
  recommendations: [{ action: 'free text' }],
};

describe('review runs → tasks', () => {
  it('parses the new review run title', () => {
    assert.equal(taskFromTitle('Review common/iso-format-parser PR #149'), 'common/iso-format-parser');
    assert.equal(taskFromTitle('Review drill/reviewer-objects PR #120'), 'drill/reviewer-objects');
    assert.equal(taskFromTitle('Review one factory PR'), null);
    assert.equal(taskFromTitle('Review  PR #1'), null);
    assert.equal(taskFromTitle('Review en/x PR #0'), null);
  });

  const d = (task: string, pr: number, min: number): ReviewDispatch => ({ task, pr, at: at(min) });
  const rr = (id: number, min: number): { run_id: number; created_at: string } => ({ run_id: id, created_at: at(min) });

  it('matches a run to the dispatch it started after, within 30 minutes', () => {
    const m = matchReviewRuns([rr(1, 1), rr(2, 61)], [d('en/a', 10, 0), d('en/b', 11, 60)]);
    assert.equal(m.get(1)?.task, 'en/a');
    assert.equal(m.get(2)?.pr, 11);
    // Exactly at the dispatch time and exactly 30 minutes later both count.
    assert.equal(matchReviewRuns([rr(1, 0)], [d('en/a', 1, 0)]).get(1)?.task, 'en/a');
    assert.equal(matchReviewRuns([rr(1, 30)], [d('en/a', 1, 0)]).get(1)?.task, 'en/a');
  });

  it('no match: before the dispatch, or too late', () => {
    assert.equal(matchReviewRuns([rr(1, -1)], [d('en/a', 1, 0)]).size, 0);
    assert.equal(matchReviewRuns([rr(1, 31)], [d('en/a', 1, 0)]).size, 0);
    assert.equal(matchReviewRuns([rr(1, 5)], []).size, 0);
  });

  it('two runs after one dispatch: only the nearest gets it; nearest dispatch wins', () => {
    const m = matchReviewRuns([rr(1, 2), rr(2, 4)], [d('en/a', 1, 0)]);
    assert.deepEqual([...m.keys()], [1]);
    // A run after two dispatches takes the later (nearer) one; the earlier one is free for another run.
    const m2 = matchReviewRuns([rr(1, 12), rr(2, 3)], [d('en/a', 1, 0), d('en/b', 2, 10)]);
    assert.equal(m2.get(1)?.task, 'en/b');
    assert.equal(m2.get(2)?.task, 'en/a');
  });

  it('collect: backfilled untitled review runs get their task; titled ones parse it', async () => {
    const gh = new FakeGitHub(REPO);
    gh.addRoute('GET', new RegExp(`^${r}/actions/workflows/(implement|repair|review)\\.lock\\.yml/runs$`), (path) => ({
      data: {
        workflow_runs: path.includes('review')
          ? [
              { id: 3, path: '.github/workflows/review.lock.yml', status: 'completed', conclusion: 'success', created_at: at(2), display_title: 'Review one factory PR' },
              { id: 4, path: '.github/workflows/review.lock.yml', status: 'completed', conclusion: 'success', created_at: at(200), display_title: 'Review one factory PR' },
              { id: 5, path: '.github/workflows/review.lock.yml', status: 'completed', conclusion: 'success', created_at: at(300), display_title: 'Review en/new PR #77' },
            ]
          : [],
      },
    }));
    const ghAw: GhAw = async (args) => (args[0] === 'logs' ? '{"runs":[]}' : JSON.stringify({ run_id: Number(args[1]), items: [] }));
    const { snapshot } = await collect({ client: gh, repo: REPO, ghAw, now: new Date(NOW.getTime() + 400 * 60_000), full: true, workDir: 'w', log: () => {}, previous: null, reviewDispatches: [d('en/casual-date', 54, 0)] });
    const by = new Map(snapshot.runs.map((x) => [x.run_id, x.task]));
    assert.deepEqual(Object.fromEntries(by), { 3: 'en/casual-date', 4: null, 5: 'en/new' });
  });
});

describe('gh-aw audit diagnosis (collector)', () => {
  it('keeps only codes and the highest severity, most severe first, at most 5', () => {
    assert.deepEqual(diagnosisFromAudit(AUDIT_26), { codes: ['workflow_failed', 'high_token_usage', 'agentic_resource_heavy_for_domain'], severity: 'critical' });
    const many = { key_findings: ['a', 'b', 'c', 'd', 'e', 'f'].map((c) => ({ code: `code_${c}`, severity: 'low' })).concat([{ code: 'top', severity: 'high' }, { code: 'Bad Code', severity: 'critical' }, { code: 'code_a', severity: 'low' }]) };
    const dg = diagnosisFromAudit(many);
    assert.deepEqual(dg.codes, ['top', 'code_a', 'code_b', 'code_c', 'code_d']);
    assert.equal(dg.severity, 'high', 'an invalid code is dropped, with its severity');
    assert.deepEqual(diagnosisFromAudit({ key_findings: [] }), { codes: [], severity: null });
    assert.deepEqual(diagnosisFromAudit({ key_findings: [{ code: 'x_y', severity: 'info' }] }), { codes: ['x_y'], severity: null });
    assert.throws(() => diagnosisFromAudit({ overview: {} }), /key_findings/);
  });

  it('applies to implement runs that failed or opened no PR', () => {
    const pr = [{ type: 'create_pull_request', object_url: null, outcome_status: 'accepted' as const, evidence_strength: 'strong' as const, zero_touch: true }];
    assert.equal(needsDiagnosis({ workflow: 'implement', conclusion: 'failure' }, pr), true);
    assert.equal(needsDiagnosis({ workflow: 'implement', conclusion: 'success' }, []), true);
    assert.equal(needsDiagnosis({ workflow: 'implement', conclusion: 'success' }, pr), false);
    assert.equal(needsDiagnosis({ workflow: 'repair', conclusion: 'failure' }, []), false);
  });

  it('validator: exact keys, code pattern, at most 5, severity enum; legacy records read as null', () => {
    const ok = (diagnosis: unknown): string => JSON.stringify(buildSnapshot(REPO, NOW, 'full', [run(1, { diagnosis: diagnosis as OutcomeRun['diagnosis'] })]));
    assert.doesNotThrow(() => validateSnapshot(ok({ codes: ['workflow_failed'], severity: 'critical' }), REPO));
    assert.doesNotThrow(() => validateSnapshot(ok(null), REPO));
    assert.throws(() => validateSnapshot(ok({ codes: ['Workflow Failed'], severity: 'critical' }), REPO), /codes\[0\]/);
    assert.throws(() => validateSnapshot(ok({ codes: ['a', 'b', 'c', 'd', 'e', 'f'], severity: null }), REPO), /at most 5/);
    assert.throws(() => validateSnapshot(ok({ codes: ['a'], severity: 'info' }), REPO), /severity/);
    assert.throws(() => validateSnapshot(ok({ codes: ['a'], severity: null, title: 'x' }), REPO), /keys/);
    assert.throws(() => validateSnapshot(ok({ codes: ['a', 'a'], severity: null }), REPO), /duplicates/);
    const legacy = { ...run(1) } as Partial<OutcomeRun>;
    delete legacy.diagnosis;
    assert.throws(() => validateRuns([legacy], REPO), /keys/, 'the ingest validator requires the field');
    assert.equal(validateRuns([legacy], REPO, { legacy: true })[0]!.diagnosis, null, 'older snapshots are read as no diagnosis');
  });

  it('collect: audits once, keeps a diagnosis, retries a failed audit', async () => {
    const gh = new FakeGitHub(REPO);
    gh.addRoute('GET', new RegExp(`^${r}/actions/workflows/(implement|repair|review)\\.lock\\.yml/runs$`), (path) => ({
      data: { workflow_runs: path.includes('implement') ? [1, 2, 3, 4].map((id) => ({ id, path: '.github/workflows/implement.lock.yml', status: 'completed', conclusion: id === 4 ? 'success' : 'failure', created_at: at(-60), display_title: `Implement en/a #1 attempt ${id}` })) : [] },
    }));
    const audited: string[] = [];
    const ghAw: GhAw = async (args) => {
      if (args[0] === 'logs') return '{"runs":[]}';
      if (args[0] === 'audit') {
        audited.push(args[1]!);
        if (args[1] === '3') throw new Error('timed out');
        return JSON.stringify(AUDIT_26);
      }
      const id = Number(args[1]);
      return JSON.stringify({ run_id: id, items: id === 4 ? [{ type: 'create_pull_request', object_url: `https://github.com/${REPO}/pull/9`, outcome_status: 'accepted', evidence_strength: 'strong' }] : [] });
    };
    const previous = new Map<number, OutcomeRun>([[2, run(2, { task: 'en/a', diagnosis: { codes: ['workflow_timeout'], severity: 'high' } })]]);
    const { snapshot } = await collect({ client: gh, repo: REPO, ghAw, now: NOW, full: false, workDir: 'w', log: () => {}, previous, reviewDispatches: [] });
    assert.deepEqual(audited.sort(), ['1', '3'], 'not run 2 (has one) nor run 4 (succeeded with a PR)');
    const by = new Map(snapshot.runs.map((x) => [x.run_id, x.diagnosis]));
    assert.deepEqual(by.get(1), { codes: ['workflow_failed', 'high_token_usage', 'agentic_resource_heavy_for_domain'], severity: 'critical' });
    assert.deepEqual(by.get(2), { codes: ['workflow_timeout'], severity: 'high' });
    assert.equal(by.get(3), null, 'failed audit: null, retried next time');
    assert.equal(by.get(4), null);
  });
});

describe('diagnosis follow-up comment (controller)', () => {
  it('renders known codes as sentences, unknown codes as code, at most 3 lines, with the run and hint', () => {
    const body = diagnosisComment(REPO, 40552111692, 'implement_failed', { codes: ['workflow_failed', 'high_token_usage', 'agentic_resource_heavy_for_domain'], severity: 'critical' });
    assert.equal(
      body,
      [
        '**Factory controller** · diagnosis of implement run 40552111692 (`implement_failed`)',
        '',
        'gh-aw audit (severity: critical):',
        '- The agent run failed before finishing.',
        '- The run used an unusually large number of tokens.',
        '- Resource use was high for this kind of task.',
        '',
        `Run: https://github.com/${REPO}/actions/runs/40552111692. For details, run \`gh aw audit 40552111692\` locally.`,
        '',
        '<!-- factory-diagnosis: 40552111692 -->',
      ].join('\n'),
    );
    const unknown = diagnosisComment(REPO, 5, 'implement_no_pr', { codes: ['brand_new_code', 'workflow_succeeded', 'many_iterations', 'high_token_usage'], severity: null });
    assert.match(unknown, /^- `brand_new_code`$/m);
    assert.equal(unknown.split('\n').filter((l) => l.startsWith('- ')).length, 3, 'more than 3 codes → 3 lines');
    assert.doesNotMatch(unknown, /severity/);
    assert.doesNotThrow(() => assertAllowedRequest(REPO, 'POST', `${r}/issues/26/comments`, { body: body }, 'live'), 'inside the live comment allowlist');
  });

  // An audit log with: the live implement_failed hand-off for run 40552111692 on #26, and a snapshot.
  async function world(diagnosis: OutcomeRun['diagnosis'], opts: { dryRunHandoff?: boolean } = {}) {
    const gh = new FakeGitHub(REPO) as FakeGitHub & { posted: string[] };
    gh.posted = [];
    gh.addRoute('GET', new RegExp(`^${r}/issues/26/comments$`), () => ({ data: gh.posted.map((body) => ({ body })) }));
    gh.addRoute('POST', new RegExp(`^${r}/issues/26/comments$`), (_p, b) => {
      gh.posted.push((b as { body: string }).body);
      return { status: 201, data: {} };
    });
    const audit = new AuditLog(gh, { repo: REPO, factoryVersion: 'f'.repeat(40), dryRun: false });
    await audit.load(NOW);
    await audit.append({ type: 'needs_human', source_ids: ['I_26', 'implement_run:40552111692', 'reason:implement_failed', 'effect:label:needs-human', 'mode:live'], fields: { reason: 'implement_failed', effect: 'label:needs-human', task: 'common/extract-timezone-abbr-refiner', issue: 26, run_id: 40552111692 }, dry_run: opts.dryRunHandoff ?? false }, NOW);
    const runs = new Map([[40552111692, run(40552111692, { diagnosis })]]);
    return { gh, audit, runs };
  }
  const issues: IssueSnap[] = [{ number: 26, node_id: 'I_26', labels: ['factory:task', 'needs-human'], task_id: 'common/extract-timezone-abbr-refiner', marker_status: 'ok' }];
  const DIAG = { codes: ['workflow_failed', 'high_token_usage', 'agentic_resource_heavy_for_domain'], severity: 'critical' as const };

  it('posts once per run, recorded in the audit log; a later poll does nothing', async () => {
    const { gh, audit, runs } = await world(DIAG);
    const due = pendingDiagnoses(audit.events, [], runs, issues, (k) => audit.hasDedupeKey(k));
    assert.deepEqual(due, [{ issue: 26, run_id: 40552111692, reason: 'implement_failed', codes: DIAG.codes, severity: 'critical' }]);
    assert.equal(await postDiagnoses(gh, REPO, audit, due, true, NOW, () => {}), 1);
    assert.equal(gh.posted.length, 1);
    assert.ok(gh.posted[0]!.includes(diagnosisMarker(40552111692)));
    assert.ok(audit.hasDedupeKey(dedupeKey(DIAGNOSIS_EVENT, ['diagnosis:40552111692'])));
    assert.deepEqual(pendingDiagnoses(audit.events, [], runs, issues, (k) => audit.hasDedupeKey(k)), []);
  });

  it('an interrupted post (comment there, no record) is only recorded, never posted twice', async () => {
    const { gh, audit, runs } = await world(DIAG);
    gh.posted.push(`x\n${diagnosisMarker(40552111692)}`);
    const due = pendingDiagnoses(audit.events, [], runs, issues, (k) => audit.hasDedupeKey(k));
    await postDiagnoses(gh, REPO, audit, due, true, NOW, () => {});
    assert.equal(gh.posted.length, 1);
    assert.ok(audit.hasDedupeKey(dedupeKey(DIAGNOSIS_EVENT, ['diagnosis:40552111692'])));
  });

  it('dry-run: logs only, posts and records nothing', async () => {
    const { gh, audit, runs } = await world(DIAG);
    const logs: string[] = [];
    const due = pendingDiagnoses(audit.events, [], runs, issues, (k) => audit.hasDedupeKey(k));
    assert.equal(await postDiagnoses(gh, REPO, audit, due, false, NOW, (l) => logs.push(l)), 0);
    assert.equal(gh.posted.length, 0);
    assert.equal(audit.events.filter((e: AuditEvent) => e.type === DIAGNOSIS_EVENT).length, 0);
    assert.match(logs[0]!, /^\[dry-run\] would post the gh-aw diagnosis of run 40552111692 on #26/);
  });

  it('no comment without a diagnosis, without codes, for a dry-run hand-off, or once the issue is back with the factory', async () => {
    for (const diagnosis of [null, { codes: [], severity: null }]) {
      const { audit, runs } = await world(diagnosis);
      assert.deepEqual(pendingDiagnoses(audit.events, [], runs, issues, (k) => audit.hasDedupeKey(k)), []);
    }
    const dry = await world(DIAG, { dryRunHandoff: true });
    assert.deepEqual(pendingDiagnoses(dry.audit.events, [], dry.runs, issues, (k) => dry.audit.hasDedupeKey(k)), []);
    const w = await world(DIAG);
    assert.deepEqual(pendingDiagnoses(w.audit.events, [], null, issues, (k) => w.audit.hasDedupeKey(k)), [], 'no snapshot');
    assert.deepEqual(pendingDiagnoses(w.audit.events, [], w.runs, [], (k) => w.audit.hasDedupeKey(k)), [], 'issue closed');
    const relabelled = [{ ...issues[0]!, labels: ['factory:task'] }];
    assert.deepEqual(pendingDiagnoses(w.audit.events, [], w.runs, relabelled, (k) => w.audit.hasDedupeKey(k)), [], 'needs-human removed');
    // The hand-off recorded in this very poll (label added after the snapshot was read) counts.
    assert.equal(pendingDiagnoses(w.audit.events, w.audit.appended, w.runs, relabelled, (k) => w.audit.hasDedupeKey(k)).length, 1);
  });

  it('a failed post is logged and retried next poll (fail-soft)', async () => {
    const { audit, runs } = await world(DIAG);
    const gh = new FakeGitHub(REPO);
    const logs: string[] = [];
    const due = pendingDiagnoses(audit.events, [], runs, issues, (k) => audit.hasDedupeKey(k));
    assert.equal(await postDiagnoses(gh, REPO, audit, due, true, NOW, (l) => logs.push(l)), 0);
    assert.match(logs[0]!, /not posted .* retried next poll/);
    assert.equal(pendingDiagnoses(audit.events, [], runs, issues, (k) => audit.hasDedupeKey(k)).length, 1);
  });
});
