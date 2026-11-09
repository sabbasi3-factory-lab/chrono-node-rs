"use strict";
// Factory v2 (docs/factory-v2.md): a `Factory-Unit: <lang>` PR is checked against all of the language's contracts.
const test = require("node:test");
const assert = require("node:assert");
const { evaluate, needsFullRegression } = require("../scope");

const PROTECTED = [".github/**", "contracts/**", "upstream/**", "tests/golden/**", "Cargo.toml", "Cargo.lock", "vendor/**"];
const SHA = "0123456789abcdef0123456789abcdef01234567";
const CONTRACTS = [
    {
        id: "it/constants",
        tier: "auto",
        scope: ["src/locales/it/constants.rs"],
        acceptance: [{ unit: { requirement: "r", cases: [{ test: "weekday_dictionary" }] } }],
    },
    {
        id: "it/weekday-parser",
        tier: "auto",
        scope: ["src/locales/it/parsers/weekday.rs"],
        acceptance: [
            { golden: { step: "ITWeekdayParser", areas: ["it/weekday", "it/casual"] } },
            { differential: { phrases: 2000, seed: 42, match: "chrono-node@d4fe7e3" } },
        ],
    },
    {
        id: "it/merge-date-time-refiner",
        tier: "auto",
        scope: ["src/locales/it/refiners/merge_date_time.rs"],
        acceptance: [{ golden: { step: "ITMergeDateTimeRefiner", areas: ["it/merge"] } }],
    },
];
const loadUnit = (unit) => (unit === "it" ? { enabled: true, contracts: CONTRACTS, lastCommit: SHA } : unit === "nl" ? { enabled: false, contracts: CONTRACTS, lastCommit: SHA } : null);
const CONSTANTS_RS = "pub const X: u8 = 1;\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn weekday_dictionary() {}\n}\n";
const readFile = (p) => (p === "src/locales/it/constants.rs" ? CONSTANTS_RS : "// ported\n");
const body = (extra = "") => `Ports Italian.\n\nFactory-Unit: it\nContract-SHA: ${SHA}\n${extra}`;
const ALL = ["src/locales/it/constants.rs", "src/locales/it/parsers/weekday.rs", "src/locales/it/refiners/merge_date_time.rs"];
const run = (over = {}) => evaluate({ isAgent: true, body: body(), changed: ALL, protectedGlobs: PROTECTED, loadContract: () => null, loadUnit, readFile, ...over });

test("a whole-language PR in scope passes and lists every contract's golden step", () => {
    const r = run();
    assert.deepStrictEqual(r.reasons, []);
    assert.deepStrictEqual([r.ok, r.kind, r.unit, r.goldenAreas, r.goldenStep], [true, "factory", "it", [], null]);
    assert.deepStrictEqual(r.unitGolden, [
        { step: "ITWeekdayParser", areas: ["it/weekday", "it/casual"] },
        { step: "ITMergeDateTimeRefiner", areas: ["it/merge"] },
    ]);
    assert.deepStrictEqual(r.differential, { seed: 42, phrases: 2000 });
});

test("a human PR with Factory-Unit is checked like the agent's (the trailer makes it a factory PR)", () => {
    assert.strictEqual(run({ isAgent: false }).kind, "factory");
});

test("protected paths, out-of-scope paths and a stale SHA are all reported (the test lock)", () => {
    const r = run({
        body: body().replace(SHA, "fedcba9"),
        changed: [...ALL, "tests/golden/it/weekday.json", "contracts/it/weekday-parser.yaml", "src/core/chrono.rs", "src/locales/nl/constants.rs"],
    });
    assert.strictEqual(r.ok, false);
    for (const want of ["protected path changed: tests/golden/it/weekday.json", "protected path changed: contracts/it/weekday-parser.yaml", "out of the scope of every it contract: src/core/chrono.rs", "out of the scope of every it contract: src/locales/nl/constants.rs"]) {
        assert.ok(r.reasons.includes(want), want);
    }
    assert.ok(r.reasons.some((x) => x.startsWith("stale contracts: PR declares fedcba9")));
});

test("each contract's own acceptance still applies (unit test missing in its scope file)", () => {
    const r = run({ readFile: () => "pub const X: u8 = 1;\n// #[test] fn weekday_dictionary() {}\n" });
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(r.reasons, ["it/constants: unit acceptance: no #[test] fn weekday_dictionary in the changed scope files"]);
});

test("fails closed: not a v2 language, unknown language, bad unit, both trailers, missing SHA", () => {
    const reasons = (over) => run(over).reasons.join("; ");
    assert.match(reasons({ body: "Factory-Unit: nl\nContract-SHA: " + SHA }), /nl is not a factory v2 language/);
    assert.match(reasons({ body: "Factory-Unit: xx\nContract-SHA: " + SHA }), /no contracts under contracts\/xx\//);
    assert.match(reasons({ body: "Factory-Unit: ../it\nContract-SHA: " + SHA }), /invalid Factory-Unit/);
    assert.match(reasons({ body: body("Factory-Task: it/weekday-parser") }), /either Factory-Task or Factory-Unit/);
    assert.match(reasons({ body: "Factory-Unit: it\n" }), /missing Contract-SHA trailer/);
    assert.match(reasons({ loadUnit: undefined }), /no contracts under contracts\/it\//);
    for (const over of [{ body: "Factory-Unit: nl\nContract-SHA: " + SHA }, { loadUnit: undefined }]) assert.strictEqual(run(over).ok, false);
});

test("full regression for a unit: any contract's auto-strict tier or scope path counts", () => {
    const strictGlobs = ["src/core/**", "src/locales/*/abstract_*.rs"];
    const scopes = CONTRACTS.flatMap((c) => c.scope);
    assert.strictEqual(needsFullRegression({ changed: ALL, autoStrictGlobs: strictGlobs, contractTier: null, contractScope: scopes }), false);
    assert.strictEqual(needsFullRegression({ changed: ALL, autoStrictGlobs: strictGlobs, contractTier: null, contractScope: [...scopes, "src/locales/it/abstract_parser.rs"] }), true);
});
