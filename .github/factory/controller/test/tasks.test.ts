import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  contractPath,
  contractShaMatches,
  globToRegExp,
  isCoreTask,
  parseContract,
  parsePrTrailers,
  parseTaskMarker,
  pathTier,
  sameArea,
  scopesOverlap,
  taskTier,
} from '../tasks.ts';
import { contract, hex40, testPolicies } from './helpers.ts';

const { tiers } = await testPolicies();

describe('task marker (issue body)', () => {
  it('reads only the hidden marker', () => {
    const body = 'Port the weekday parser.\n\n<!-- factory-task: en/weekday-parser -->\nfactory-task: evil/other';
    assert.deepEqual(parseTaskMarker(body), { task_id: 'en/weekday-parser', status: 'ok' });
  });

  it('is missing without a marker', () => {
    assert.deepEqual(parseTaskMarker(null), { task_id: null, status: 'missing' });
    assert.deepEqual(parseTaskMarker('factory-task: en/x'), { task_id: null, status: 'missing' });
    assert.deepEqual(parseTaskMarker('<!--factory-task: en/x-->'), { task_id: null, status: 'missing' });
  });

  it('is invalid for conflicting markers or bad ids', () => {
    assert.equal(parseTaskMarker('<!-- factory-task: en/a -->\n<!-- factory-task: en/b -->').status, 'invalid');
    assert.equal(parseTaskMarker('<!-- factory-task: ../../etc -->').status, 'invalid');
    assert.equal(parseTaskMarker('<!-- factory-task: EN/Upper -->').status, 'invalid');
  });

  it('accepts a repeated identical marker', () => {
    assert.equal(parseTaskMarker('<!-- factory-task: en/a -->\n<!-- factory-task: en/a -->').task_id, 'en/a');
  });

  it('maps task ids to contract paths and rejects traversal', () => {
    assert.equal(contractPath('en/weekday-parser'), 'contracts/en/weekday-parser.yaml');
    assert.throws(() => contractPath('../x'));
  });
});

describe('PR trailers', () => {
  it('parses Factory-Task, Contract-SHA and Factory-Attempt lines', () => {
    const body = 'Implements the parser.\r\n\r\nFactory-Task: en/weekday-parser\r\nFactory-Attempt: 2\r\nContract-SHA: a1b2c3d\r\n';
    assert.deepEqual(parsePrTrailers(body), { task_id: 'en/weekday-parser', contract_sha: 'a1b2c3d', attempt: 2 });
  });

  it('fails closed on conflicts and malformed values', () => {
    assert.equal(parsePrTrailers('Contract-SHA: a1b2c3d\nContract-SHA: ffffff0').contract_sha, null);
    assert.equal(parsePrTrailers('Contract-SHA: a1b2c3').contract_sha, null);
    assert.equal(parsePrTrailers('Contract-SHA: A1B2C3D').contract_sha, null);
    assert.equal(parsePrTrailers('Factory-Task: ../x').task_id, null);
    assert.equal(parsePrTrailers('  Contract-SHA: a1b2c3d').contract_sha, null);
    assert.deepEqual(parsePrTrailers(null), { task_id: null, contract_sha: null, attempt: null });
  });
});

describe('contract SHA comparison', () => {
  const full = hex40('a').replace(/^a{7}/, '1234567');
  it('accepts the full commit SHA or a ≥7-hex prefix', () => {
    assert.ok(contractShaMatches(full, full));
    assert.ok(contractShaMatches('1234567', full));
    assert.ok(contractShaMatches('1234567aaa', full));
  });
  it('rejects short, different or missing SHAs', () => {
    assert.ok(!contractShaMatches('123456', full));
    assert.ok(!contractShaMatches('1234568', full));
    assert.ok(!contractShaMatches(null, full));
    assert.ok(!contractShaMatches('1234567', 'short'));
  });
});

describe('contract parsing', () => {
  const ok = `id: en/weekday-parser
tier: auto
source: upstream/src/locales/en/parsers/ENWeekdayParser.ts
scope:
  - src/locales/en/parsers/weekday.rs
  - tests/en/weekday.rs
depends_on: [core/results, core/weekday-calculation]
priority: 3
`;
  it('parses a valid contract', () => {
    const c = parseContract('contracts/en/weekday-parser.yaml', hex40('b'), hex40('c'), ok);
    assert.equal(c.valid, true);
    assert.equal(c.id, 'en/weekday-parser');
    assert.deepEqual(c.depends_on, ['core/results', 'core/weekday-calculation']);
    assert.equal(c.priority, 3);
    assert.equal(c.last_commit_sha, hex40('c'));
  });
  it('marks mismatched ids, bad tiers, empty scopes and bad YAML invalid', () => {
    const p = 'contracts/en/weekday-parser.yaml';
    assert.equal(parseContract(p, 'b', hex40('c'), ok.replace('id: en/weekday-parser', 'id: en/other')).valid, false);
    assert.equal(parseContract(p, 'b', hex40('c'), ok.replace('tier: auto', 'tier: yolo')).valid, false);
    assert.equal(parseContract(p, 'b', hex40('c'), 'id: en/weekday-parser\ntier: auto\nscope: []\n').valid, false);
    assert.equal(parseContract(p, 'b', hex40('c'), ': : :\n- [').valid, false);
    assert.equal(parseContract(p, 'b', 'not-a-sha', ok).valid, false);
  });
});

describe('globs and tiers', () => {
  it('matches * within a segment and ** across segments', () => {
    assert.ok(globToRegExp('src/locales/*/parsers/**').test('src/locales/en/parsers/weekday.rs'));
    assert.ok(!globToRegExp('src/locales/*/parsers/**').test('src/locales/en/x/parsers/a.rs'));
    assert.ok(globToRegExp('NOTICE').test('NOTICE'));
    assert.ok(!globToRegExp('src/core/**').test('src/corex/a.rs'));
  });

  it('classifies paths, strictest first; unknown paths are human', () => {
    assert.equal(pathTier('src/locales/en/parsers/weekday.rs', tiers), 'auto');
    assert.equal(pathTier('tests/locales/en/weekday.rs', tiers), 'auto');
    assert.equal(pathTier('src/core/results.rs', tiers), 'human'); // auto-strict starts as human
    assert.equal(pathTier('.github/workflows/ci.yml', tiers), 'human');
    assert.equal(pathTier('src/lib.rs', tiers), 'human');
    const promoted = { ...tiers, tiers: { ...tiers.tiers, 'auto-strict': { paths: tiers.tiers['auto-strict'].paths } } };
    assert.equal(pathTier('src/core/results.rs', promoted), 'auto-strict');
  });

  it('task tier is the strictest of contract tier and scope tiers', () => {
    assert.equal(taskTier(contract('en/a'), tiers), 'auto');
    assert.equal(taskTier(contract('en/a', { tier: 'human' }), tiers), 'human');
    assert.equal(taskTier(contract('en/a', { scope: ['src/locales/en/parsers/a.rs', 'tests/golden/en/a.json'] }), tiers), 'human');
    assert.equal(taskTier(contract('en/a', { valid: false }), tiers), 'human');
  });

  it('core tasks touch auto-strict paths', () => {
    assert.ok(isCoreTask(contract('core/a', { scope: ['src/core/a.rs'] }), tiers));
    assert.ok(!isCoreTask(contract('en/a'), tiers));
  });

  it('detects overlapping scopes and shared areas', () => {
    assert.ok(scopesOverlap(['src/a.rs'], ['src/a.rs']));
    assert.ok(scopesOverlap(['src/locales/en/**'], ['src/locales/en/parsers/x.rs']));
    assert.ok(scopesOverlap(['src/locales/*/parsers/x.rs'], ['src/locales/en/**']));
    assert.ok(!scopesOverlap(['src/a.rs'], ['src/b.rs']));
    assert.ok(sameArea(contract('en/a', { area: 'x' }), contract('en/b', { area: 'x' })));
    assert.ok(!sameArea(contract('en/a'), contract('en/b')));
  });
});
