"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { blame, isolateRequests } = require("../frontier");

const r = (text) => [{ index: 0, text, start: { known: {}, implied: {}, date: null, tags: [] }, end: null }];
const js = {
    parsers: [{ step: "P1", results: r("a") }, { step: "P2", results: [] }],
    refiners: [{ step: "R1", results: r("a") }, { step: "R2", results: r("ab") }, { step: "R1", results: r("abc") }],
};

test("blame: the earliest ported step whose own output differs", () => {
    assert.strictEqual(blame(js, js), null);
    // #397's shape: a ported parser differs on a case whose refiner isn't ported yet.
    const parserBug = { parsers: [{ step: "P1", results: r("x") }, js.parsers[1]], refiners: [js.refiners[0]] };
    assert.deepStrictEqual([blame(js, parserBug).step, blame(js, parserBug).kind], ["P1", "parser"]);
    // A refiner after an equal prefix.
    const refinerBug = { ...js, refiners: [js.refiners[0], { step: "R2", results: r("zz") }, js.refiners[2]] };
    assert.strictEqual(blame(js, refinerBug).step, "R2");
    // A repeated refiner is matched by occurrence.
    const secondR1 = { ...js, refiners: [js.refiners[0], js.refiners[1], { step: "R1", results: r("no") }] };
    assert.deepStrictEqual([blame(js, secondR1).step, blame(js, secondR1).expected], ["R1", r("abc")]);
});

test("blame: nothing past an unported step is comparable", () => {
    // R2 unported: R1#1 after it sees different inputs, so its difference isn't blamed.
    const missingRefiner = { ...js, refiners: [js.refiners[0], { step: "R1", results: r("no") }] };
    assert.strictEqual(blame(js, missingRefiner), null);
    // A parser unported: refiners see other inputs; the ported parsers are still compared.
    const missingParser = { parsers: [js.parsers[0]], refiners: [{ step: "R1", results: r("no") }] };
    assert.strictEqual(blame(js, missingParser), null);
    assert.strictEqual(blame(js, { parsers: [{ step: "P1", results: [] }], refiners: [] }).step, "P1");
});

test("blame: key order doesn't matter (Rust and JS serialize objects in different orders)", () => {
    const reordered = { ...js, parsers: [{ step: "P1", results: [{ end: null, text: "a", index: 0, start: { tags: [], date: null, implied: {}, known: {} } }] }, js.parsers[1]] };
    assert.strictEqual(blame(js, reordered), null);
});

test("blame: isolated refiners are checked behind an unported step", () => {
    // R2 unported; R1#1 run alone on chrono-node's input for its slot still differs: blamed.
    const iso = (step, occurrence, results) => ({ step, occurrence, results });
    const rust = { parsers: js.parsers, refiners: [js.refiners[0]], isolated: [iso("R1", 0, r("a")), { step: "R2", occurrence: 0, error: "R2 isn't ported" }, iso("R1", 1, r("no"))] };
    assert.deepStrictEqual([blame(js, rust).step, blame(js, rust).kind, blame(js, rust).expected], ["R1", "refiner", r("abc")]);
    // The same with an unported parser: refiners are still checked alone.
    assert.strictEqual(blame(js, { ...rust, parsers: [js.parsers[0]] }).step, "R1");
    // All match alone: nothing to blame while a step is unported.
    const ok = { ...rust, isolated: [iso("R1", 0, r("a")), iso("R1", 1, r("abc"))] };
    assert.strictEqual(blame(js, ok), null);
});

test("blame: every step matches alone but the end results differ: the chain", () => {
    const jsr = { ...js, results: r("abc") };
    const all = { parsers: js.parsers, refiners: js.refiners, results: r("zzz"), isolated: [{ step: "R1", occurrence: 0, results: r("a") }, { step: "R2", occurrence: 0, results: r("ab") }, { step: "R1", occurrence: 1, results: r("abc") }] };
    assert.deepStrictEqual([blame(jsr, all).step, blame(jsr, all).kind], ["chain", "chain"]);
    assert.strictEqual(blame(jsr, { ...all, results: r("abc") }), null);
});

test("isolateRequests: each refiner slot with its occurrence and chrono-node's input", () => {
    const t = { refiners: [{ step: "R1", input: [], results: r("a") }, { step: "R2", input: r("a"), results: r("ab") }, { step: "R1", input: r("ab"), results: r("abc") }] };
    assert.deepStrictEqual(isolateRequests(t), [{ step: "R1", occurrence: 0, input: [] }, { step: "R2", occurrence: 1 - 1, input: r("a") }, { step: "R1", occurrence: 1, input: r("ab") }]);
});
