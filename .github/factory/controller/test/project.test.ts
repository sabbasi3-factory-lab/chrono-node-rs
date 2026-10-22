import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertAllowedRequest, PROJECT_STATUS_MUTATION } from '../github.ts';
import { desiredStatus, planStatusChanges, readProject, statusContext, syncProject, type StatusContext } from '../project.ts';
import type { Decision } from '../types.ts';
import { mergedPull, pull, REPO, snapshot } from './helpers.ts';
import { fakeWorld, projectNode } from './world.ts';

const T = 'en/casual-date';
const ctx = (over: Partial<StatusContext> = {}): StatusContext => ({ merged: new Set(), openPrLabels: new Map(), ...over });
const item = (labels: string[], open = true, task: string | null = T) => ({ open, labels, task_id: task });

describe('project: desired Factory status', () => {
  it('Proposed → Ready → Building → Checks → Live', () => {
    assert.equal(desiredStatus(item(['factory:task']), ctx()), 'Proposed');
    assert.equal(desiredStatus(item(['factory:ready']), ctx()), 'Ready');
    assert.equal(desiredStatus(item(['factory:ready', 'factory:picked']), ctx()), 'Building');
    assert.equal(desiredStatus(item(['factory:ready', 'factory:picked']), ctx({ openPrLabels: new Map([[T, []]]) })), 'Checks');
    assert.equal(desiredStatus(item(['factory:ready', 'factory:picked']), ctx({ merged: new Set([T]) })), 'Live');
    assert.equal(desiredStatus(item([], false), ctx({ merged: new Set([T]) })), 'Live', 'closed and merged');
  });

  it('Needs you when the issue or its open PR is handed to a person (needs-human, blocked, stale-contract)', () => {
    for (const l of ['needs-human', 'blocked', 'stale-contract']) {
      assert.equal(desiredStatus(item(['factory:ready', l]), ctx()), 'Needs you', `issue ${l}`);
      assert.equal(desiredStatus(item(['factory:ready', 'factory:picked']), ctx({ openPrLabels: new Map([[T, [l]]]) })), 'Needs you', `PR ${l}`);
    }
    assert.equal(desiredStatus(item(['needs-human']), ctx({ merged: new Set([T]) })), 'Live', 'merged wins');
  });

  it('leaves alone: no task marker, or an issue closed without its task merged', () => {
    assert.equal(desiredStatus(item(['factory:ready'], true, null), ctx()), null);
    assert.equal(desiredStatus(item(['factory:ready'], false), ctx()), null);
  });

  it('context: merged tasks, open PR labels, plus labels this run added to PRs', () => {
    const s = snapshot({ pulls: [mergedPull(5, 'en/a'), pull(6, { task_id: T, labels: ['x'] }), pull(7, { task_id: 'en/c', state: 'closed' })] });
    const d = { type: 'needs_human', reason: 'gates_failed', effect: 'label:needs-human', pr: 6 } as Decision;
    const c = statusContext(s, [d]);
    assert.deepEqual([...c.merged], ['en/a']);
    assert.deepEqual(c.openPrLabels.get(T), ['x', 'needs-human']);
    assert.equal(c.openPrLabels.has('en/c'), false);
  });
});

describe('project: read and sync', () => {
  const items = [
    { item: 'PVTI_a', issue: 3, status: 'Proposed', labels: ['factory:ready'] },
    { item: 'PVTI_b', issue: 4, status: 'Ready', labels: ['factory:ready'], task: 'en/b' },
    { item: 'PVTI_c', issue: 5, status: null, labels: [], task: 'en/c', open: false },
    { item: 'PVTI_d', issue: 6, status: 'Proposed', labels: [], task: null },
    { item: 'PVTI_e', issue: 7, status: 'Proposed', labels: ['factory:ready'], repo: 'other/repo' },
  ];

  it('reads only this repo’s issues, with status, labels and task marker', async () => {
    const gh = fakeWorld();
    gh.project = projectNode(items);
    const p = await readProject(gh, REPO);
    assert.equal(p.field_id, 'PVTSSF_1');
    assert.equal(p.options['Needs you'], '00000005');
    assert.deepEqual(p.items.map((i) => [i.issue, i.status, i.open, i.task_id]), [[3, 'Proposed', true, T], [4, 'Ready', true, 'en/b'], [5, null, false, 'en/c'], [6, 'Proposed', true, null]]);
    assert.deepEqual(planStatusChanges(p, ctx({ merged: new Set(['en/c']) })).map((c) => [c.issue, c.from, c.to]), [[3, 'Proposed', 'Ready'], [5, null, 'Live']]);
  });

  it('live: one exact mutation per change, all on the live allowlist; dry-run sends none', async () => {
    const gh = fakeWorld();
    gh.project = projectNode(items);
    const sent: unknown[] = [];
    gh.routes.unshift({ method: 'POST', path: /^\/graphql$/, handler: (_p, body) => {
      const b = body as { query: string; variables: unknown };
      if (b.query !== PROJECT_STATUS_MUTATION) return { data: { data: { organization: { projectV2: gh.project } } } };
      sent.push(b.variables);
      return { data: { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'x' } } } } };
    } });
    const dry = await syncProject(gh, REPO, ctx({ merged: new Set(['en/c']) }), false, () => {});
    assert.equal(dry.changes.length, 2);
    assert.deepEqual(sent, []);
    const live = await syncProject(gh, REPO, ctx({ merged: new Set(['en/c']) }), true, () => {});
    assert.deepEqual([live.applied, live.error], [2, null]);
    assert.deepEqual(sent, [
      { project: 'PVT_1', item: 'PVTI_a', field: 'PVTSSF_1', option: '00000001' },
      { project: 'PVT_1', item: 'PVTI_c', field: 'PVTSSF_1', option: '00000006' },
    ]);
    for (const c of gh.calls) assert.doesNotThrow(() => assertAllowedRequest(REPO, c.method, c.path, c.body, 'live'));
  });

  it('never throws: an unreadable Project, a missing option or a refused update stops the sync and is reported', async () => {
    const gh = fakeWorld();
    gh.project = null;
    assert.match((await syncProject(gh, REPO, ctx(), true, () => {})).error ?? '', /project 1 not found/);
    const noLive = projectNode([{ item: 'PVTI_c', issue: 5, status: 'Ready', task: 'en/c' }]) as { field: { options: { name: string }[] } };
    noLive.field.options = noLive.field.options.filter((o) => o.name !== 'Live');
    gh.project = noLive;
    assert.match((await syncProject(gh, REPO, ctx({ merged: new Set(['en/c']) }), true, () => {})).error ?? '', /no "Live" option/);
    gh.project = projectNode([{ item: 'PVTI_c', issue: 5, status: 'Ready', task: 'en/c' }]);
    // fakeWorld answers the mutation with a pulls payload: not a successful update.
    assert.match((await syncProject(gh, REPO, ctx({ merged: new Set(['en/c']) }), true, () => {})).error ?? '', /status update for #5 failed/);
  });

  it('allowlist: only the exact mutation with Project, item, single-select field and option ids, live only', () => {
    const ok = { query: PROJECT_STATUS_MUTATION, variables: { project: 'PVT_1', item: 'PVTI_a', field: 'PVTSSF_1', option: '1038f00d' } };
    assert.doesNotThrow(() => assertAllowedRequest(REPO, 'POST', '/graphql', ok, 'live'));
    assert.throws(() => assertAllowedRequest(REPO, 'POST', '/graphql', ok, 'dry-run'));
    const bad = [
      { ...ok, query: PROJECT_STATUS_MUTATION.replace('singleSelectOptionId: $option', 'text: $option') },
      { ...ok, variables: { ...ok.variables, extra: 1 } },
      { ...ok, variables: { ...ok.variables, field: 'PVTF_1' } },
      { ...ok, variables: { ...ok.variables, item: 'I_1' } },
      { ...ok, variables: { ...ok.variables, option: 'Live' } },
      { query: 'mutation { deleteProjectV2Item(input: {projectId: "PVT_1", itemId: "PVTI_a"}) { deletedItemId } }' },
    ];
    for (const b of bad) assert.throws(() => assertAllowedRequest(REPO, 'POST', '/graphql', b, 'live'), JSON.stringify(b).slice(0, 80));
  });
});
