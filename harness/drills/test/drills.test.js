"use strict";
const test = require("node:test");
const assert = require("node:assert");
const lib = require("../lib");

test("plant: exactly one expectation changes", () => {
    const text = JSON.stringify({ cases: [{ results: [] }, { results: [{ index: 3, text: "x" }, { index: 9 }] }] }, null, 2) + "\n";
    const planted = JSON.parse(lib.plantGoldenMismatch(text));
    assert.deepStrictEqual(planted.cases[1].results, [{ index: 4, text: "x" }, { index: 9 }]);
    assert.throws(() => lib.plantGoldenMismatch(JSON.stringify({ cases: [{ results: [] }] })), /no case/);
});

test("scope cases: a control that passes and three faults with their reasons", () => {
    const cases = lib.scopeCases({ task: "en/a-parser", contract: { scope: ["src/locales/en/parsers/a.rs"], lastCommit: "f".repeat(40) } });
    assert.deepStrictEqual(cases.map((c) => [c.name, c.ok]), [["control: in scope", true], ["out of scope", false], ["protected path", false], ["stale contract", false]]);
    assert.ok(cases[0].body.includes(`Contract-SHA: ${"f".repeat(40)}`));
});

test("pickContract: the first plain contract (one scope file, no unit or fix)", () => {
    const docs = { "en/a": { scope: ["x"], acceptance: [{ unit: {} }] }, "en/b": { scope: ["x", "y"] }, "en/c": { scope: ["z"], acceptance: [{ golden: {} }] } };
    assert.strictEqual(lib.pickContract(Object.keys(docs), (id) => docs[id]), "en/c");
    assert.throws(() => lib.pickContract(["en/a"], (id) => docs[id]), /no plain contract/);
});

test("controller reasons are counted from printed events", () => {
    assert.deepStrictEqual(lib.controllerReasons('{"reason":"kill_switch"}\n{"x":1,"reason":"kill_switch"} {"reason":"budget_pause"}'), { kill_switch: 2, budget_pause: 1 });
});

test("audit tampering: a changed payload keeps the files, truncation halves the events", () => {
    const files = [
        { path: "audit/2026/11/01.jsonl", content: '{"id":"a1","payload":{"dry_run":true}}\n{"id":"a2","payload":{"dry_run":true}}\n' },
        { path: "audit/2026/11/02.jsonl", content: '{"id":"b1","payload":{"dry_run":true}}\n{"id":"b2"}\n' },
    ];
    const t = lib.tamperPayload(files);
    assert.strictEqual(t.length, 2);
    assert.notDeepStrictEqual(t, files);
    assert.strictEqual(t.filter((f, i) => f.content !== files[i].content).length, 1);
    const h = lib.truncateHalf(files);
    assert.deepStrictEqual(h, [files[0]]);
});

test("schedule: about weekly at random, always when the last pass is old or unknown", () => {
    const now = Date.parse("2026-11-04T12:00:00Z");
    assert.strictEqual(lib.shouldRun({ now, lastPassAt: null, random: 0.99 }).run, true);
    assert.strictEqual(lib.shouldRun({ now, lastPassAt: "2026-10-27T11:00:00Z", random: 0.99 }).run, true);
    assert.strictEqual(lib.shouldRun({ now, lastPassAt: "2026-11-02T00:00:00Z", random: 0.99 }).run, false);
    assert.strictEqual(lib.shouldRun({ now, lastPassAt: "2026-11-02T00:00:00Z", random: 0.01 }).run, true);
});

test("compare summary and daily seed", () => {
    assert.deepStrictEqual(lib.compareSummary('x\ncomparison with chrono-node: {"mismatched":1}\n'), { mismatched: 1 });
    assert.strictEqual(lib.compareSummary("nothing"), null);
    assert.strictEqual(lib.seedFor(new Date("2026-11-04T01:00:00Z")), lib.seedFor(new Date("2026-11-04T23:00:00Z")));
    assert.notStrictEqual(lib.seedFor(new Date("2026-11-04T01:00:00Z")), lib.seedFor(new Date("2026-11-05T01:00:00Z")));
});

test("onboard cases: one complete control, faults that each break exactly one input", () => {
    const cases = lib.onboardCases({ stop: { min_sample: 3, budget_aic: 50 } }, "fi");
    assert.deepStrictEqual(cases.map((c) => c.ok), [true, false, false, false, false, false, false]);
    const control = cases[0].files;
    assert.strictEqual(JSON.parse(control.runs).length, 3);
    assert.ok(JSON.parse(control.runs).every((r) => /^Implement fi\/drill-step-\d #\d attempt 1$/.test(r.title)));
    for (const c of cases.slice(1)) assert.strictEqual(Object.keys(c.files).filter((k) => c.files[k] !== control[k]).length, 1, c.name);
});
