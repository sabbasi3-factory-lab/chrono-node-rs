import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FakeGitHub } from '../fake.ts';
import { LABEL_ALERT, REVERT_REVIEWED_LABEL } from '../github.ts';
import { labelWarning, missingLabels, requiredLabels } from '../labels.ts';
import { AUTO_READY_HOLDS, LABEL_NEEDS_HUMAN, LABEL_PICKED, LABEL_READY, LABEL_TASK } from '../planner.ts';
import { REPO } from './helpers.ts';

describe('factory labels (.github/factory/labels.json)', () => {
  it('lists every label the controller reads or writes, including the revert hand-off', async () => {
    const names = await requiredLabels();
    for (const l of [LABEL_TASK, LABEL_READY, LABEL_PICKED, LABEL_NEEDS_HUMAN, LABEL_ALERT, REVERT_REVIEWED_LABEL, ...AUTO_READY_HOLDS]) {
      assert.ok(names.includes(l), `labels.json lacks ${l}`);
    }
    assert.equal(new Set(names).size, names.length, 'no duplicates');
  });

  it('startup check: reports the missing ones; an unreadable list is null (a warning, never a failure)', async () => {
    const gh = new FakeGitHub(REPO);
    gh.addRoute('GET', new RegExp(`^/repos/${REPO}/labels$`), () => ({ data: [{ name: 'factory:task' }, { name: 'needs-human' }] }));
    assert.deepEqual(await missingLabels(gh, REPO, ['factory:task', 'factory:revert-reviewed', 'needs-human', 'factory:alert']), ['factory:revert-reviewed', 'factory:alert']);
    const down = new FakeGitHub(REPO);
    down.addRoute('GET', new RegExp(`^/repos/${REPO}/labels$`), () => ({ status: 500, data: null }));
    assert.equal(await missingLabels(down, REPO, ['factory:task']), null);
  });

  it('the startup check never throws: a broken labels.json or an unreadable label list is a warning line', async () => {
    const gh = new FakeGitHub(REPO);
    gh.addRoute('GET', new RegExp(`^/repos/${REPO}/labels$`), () => ({ data: [{ name: 'factory:task' }] }));
    assert.match((await labelWarning(gh, REPO, async () => { throw new Error('bad json'); }))!, /could not load .github\/factory\/labels.json .*bad json/);
    assert.match((await labelWarning(gh, REPO, async () => ['factory:task', 'factory:alert']))!, /factory labels missing .*: factory:alert$/);
    assert.equal(await labelWarning(gh, REPO, async () => ['factory:task']), null);
    const down = new FakeGitHub(REPO);
    down.addRoute('GET', new RegExp(`^/repos/${REPO}/labels$`), () => ({ status: 500, data: null }));
    assert.match((await labelWarning(down, REPO, async () => ['x']))!, /could not read the repo labels/);
  });
});
