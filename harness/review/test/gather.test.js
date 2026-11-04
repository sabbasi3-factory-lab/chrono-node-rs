"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { auditCounts, compactRuns, areas, summaryMd } = require("../gather");

const ev = (type, ts, payload) => ({ type, timestamp: ts, payload: { dry_run: false, ...payload } });
const NOW = new Date("2026-11-10T00:00:00Z");

test("auditCounts: merged tasks, first-try merges, repairs, needs-human reasons", () => {
    const c = auditCounts([
        ev("merged", "2026-11-05T00:00:00Z", { task: "en/a" }),
        ev("merged", "2026-11-06T00:00:00Z", { task: "en/b" }),
        ev("repair_dispatched", "2026-11-05T12:00:00Z", { task: "en/b", reason: "ci_failed" }),
        ev("needs_human", "2026-11-07T00:00:00Z", { task: "en/c", reason: "review_objected" }),
    ]);
    assert.deepStrictEqual([c.merged_tasks, c.merged_first_try, c.repairs, c.needs_human_by_reason], [2, 1, 1, { review_objected: 1 }]);
    assert.strictEqual(c.by_type_reason["repair_dispatched/ci_failed"], 1);
});

test("areas: eligible only with 15+ tasks merged since the area's last change (within the window)", () => {
    const merged = Array.from({ length: 16 }, (_, i) => ev("merged", `2026-11-0${4 + (i % 5)}T0${i % 10}:00:00Z`, { task: `en/t${i}` }));
    const a = areas({ "prompt:implement": "2026-11-01T00:00:00Z", "policy:budgets": "2026-11-08T00:00:00Z", "policy:x": null }, merged, NOW);
    assert.deepStrictEqual(a.map((x) => [x.area, x.tasks_since, x.eligible]), [["prompt:implement", 16, true], ["policy:budgets", 3, false], ["policy:x", 16, true]]);
});

test("compactRuns and summaryMd", () => {
    const runs = compactRuns({ runs: [{ run_id: 1, workflow_name: "Implement en/a #1 attempt 1", model: "m", conclusion: "success", duration: "5m", aic: 20, token_usage: 100, friction: { friction_ratio: 0, cost: { turns: 3 } } }] }, "implement");
    assert.deepStrictEqual(runs[0], { workflow: "implement", run_id: 1, title: "Implement en/a #1 attempt 1", model: "m", conclusion: "success", duration: "5m", aic: 20, tokens: 100, turns: 3, friction_ratio: 0, created_at: undefined });
    const md = summaryMd(auditCounts([]), runs, [{ area: "prompt:implement", last_change: null, tasks_since: 0, eligible: false }], { runs: [], summary: {} });
    assert.match(md, /\| prompt:implement \| unknown \| 0 \| no \|/);
    assert.match(md, /\| implement \| 1 \| 1 \| 20\.0 \| 20\.0 \|/);
});
