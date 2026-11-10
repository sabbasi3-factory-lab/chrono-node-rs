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
    assert.deepStrictEqual(a.map((x) => [x.area, x.tasks_since, x.eligible]), [["prompt:implement", 16, true], ["policy:budgets", 3, false], ["policy:x", 0, false]]);
});

test("compactRuns and summaryMd", () => {
    const runs = compactRuns({ runs: [{ run_id: 1, workflow_name: "Implement en/a #1 attempt 1", model: "m", conclusion: "success", duration: "5m", aic: 20, token_usage: 100, turns: 9, friction: { friction_ratio: 0, cost: { turns: 0 } } }] }, "implement");
    assert.deepStrictEqual(runs[0], { workflow: "implement", run_id: 1, title: "Implement en/a #1 attempt 1", model: "m", conclusion: "success", duration: "5m", aic: 20, tokens: 100, turns: 9, friction_ratio: 0, created_at: undefined });
    const md = summaryMd(auditCounts([]), runs, [{ area: "prompt:implement", last_change: null, tasks_since: 0, eligible: false }], { runs: [], summary: {} });
    assert.match(md, /\| prompt:implement \| unknown \| 0 \| no \|/);
    assert.match(md, /\| implement \| 1 \| 1 \| 20\.0 \| 20\.0 \|/);
});

test("budget gate: today's live total plus the worst case must stay under the pause; unknown → no run", () => {
    const { gate } = require("../budget-gate");
    const budgets = { per_run: { factory_review: 500, threat_detection: 400, overshoot_margin: 400 }, factory_per_day: { max_aic: 10000, pause_at_pct: 100 } };
    const snap = (aic, day = "2026-11-10", dry = false) => ({ type: "spend_snapshot", payload: { day, aic_today: aic, dry_run: dry } });
    const now = new Date("2026-11-10T06:00:00Z");
    assert.ok(gate({ snapshots: [snap(9000), snap(8200)], budgets, now }).ok, "8200 + 1700 = 9900");
    assert.ok(!gate({ snapshots: [snap(8400)], budgets, now }).ok, "8400 + 1700 > 10000");
    assert.ok(!gate({ snapshots: [], budgets, now }).ok, "no snapshot");
    assert.ok(!gate({ snapshots: [snap(10, "2026-11-09")], budgets, now }).ok, "yesterday's");
    assert.ok(!gate({ snapshots: [snap(10, "2026-11-10", true)], budgets, now }).ok, "dry run");
    assert.ok(!gate({ snapshots: [snap(null)], budgets, now }).ok, "unknown total");
});

test("first tries see repairs from before the window; eligibility uses the merge time; even-count medians average", () => {
    const merged = ev("merged", "2026-11-04T00:30:00Z", { task: "en/a" });
    const early = ev("repair_dispatched", "2026-11-02T23:00:00Z", { task: "en/a" });
    assert.strictEqual(auditCounts([merged], [early]).merged_first_try, 0);
    // Recorded after the change, but merged before it: not counted.
    const late = Array.from({ length: 15 }, (_, i) => ev("merged", "2026-11-09T00:00:00Z", { task: `en/t${i}`, merged_at: "2026-11-07T00:00:00Z" }));
    assert.deepStrictEqual(areas({ "prompt:x": "2026-11-08T00:00:00Z" }, late, NOW).map((a) => [a.tasks_since, a.eligible]), [[0, false]]);
    const runs = [20, 100].map((aic, i) => ({ workflow: "implement", run_id: i, conclusion: "success", aic }));
    assert.match(summaryMd(auditCounts([]), runs, [], { runs: [], summary: {} }), /\| implement \| 2 \| 2 \| 120\.0 \| 60\.0 \|/);
});

test("outcomesOf: gh-aw's per-run verdicts from `gh aw logs --outcomes` (outcomes.yml retired)", () => {
    const { outcomesOf, summaryMd, auditCounts } = require("../gather");
    const logs = [
        { runs: [], outcomes: [
            { run_id: 1, workflow: "Implement en/a #1 attempt 1", items: [{ type: "create_pull_request", object_url: "https://github.com/o/r/pull/5", outcome_status: "accepted", zero_touch: true, extra: 1 }] },
            { run_id: 2, workflow: "Implement drill/x #1 attempt 1", items: [], eval_error: "safe-output manifest unavailable; outcome coverage is unknown" },
            { run_id: "bad", items: [] },
        ] },
        { runs: [], outcomes: [{ run_id: 3, items: [{ type: "create_pull_request", outcome_status: "rejected" }, { type: "add_comment", outcome_status: "accepted" }] }] },
        { runs: [] },
        null,
    ];
    const o = outcomesOf(logs);
    assert.deepStrictEqual(o.summary, { accepted: 2, rejected: 1 });
    assert.deepStrictEqual(o.runs.map((r) => r.run_id), [1, 2, 3]);
    assert.deepStrictEqual(o.runs[0].items[0], { type: "create_pull_request", object_url: "https://github.com/o/r/pull/5", outcome_status: "accepted", zero_touch: true });
    assert.strictEqual(o.runs[1].eval_error, "safe-output manifest unavailable; outcome coverage is unknown");
    assert.match(summaryMd(auditCounts([]), [], [], o), /## Outcomes \(gh aw logs --outcomes\)\n\n- runs in the window: 3 \(1 not evaluable\); item statuses: \{"accepted":2,"rejected":1\}/);
});
