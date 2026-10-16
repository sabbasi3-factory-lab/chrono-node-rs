"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { globToRegExp, evaluate, trailer } = require("../scope");

const PROTECTED = [".github/**", "contracts/**", "upstream/**", "tests/golden/**", "Cargo.toml", "Cargo.lock", "vendor/**"];
const CONTRACT = {
    scope: ["src/locales/en/parsers/weekday.rs", "tests/locales/en/weekday.rs"],
    acceptance: [
        { golden: { step: "ENWeekdayParser", areas: ["en/weekday", "en/casual"] } },
        { differential: { phrases: 2000, seed: 42, match: "chrono-node@d4fe7e3" } },
        { clippy: "deny-warnings" },
    ],
    lastCommit: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
};
const loadContract = (task) => (task === "en/weekday-parser" ? CONTRACT : null);
const body = (extra = "") => `Ports the weekday parser.\n\nFactory-Task: en/weekday-parser\nContract-SHA: a1b2c3d\n${extra}`;

test("glob semantics", () => {
    assert.ok(globToRegExp(".github/**").test(".github/workflows/ci.yml"));
    assert.ok(globToRegExp("src/locales/*/parsers/**").test("src/locales/en/parsers/a.rs"));
    assert.ok(!globToRegExp("src/locales/*/parsers/**").test("src/locales/en/x/parsers/a.rs"));
    assert.ok(globToRegExp("Cargo.toml").test("Cargo.toml"));
    assert.ok(!globToRegExp("Cargo.toml").test("Cargo.tomlx"));
    assert.ok(globToRegExp("src/**/mod.rs").test("src/mod.rs"));
    assert.ok(!globToRegExp("src/*.rs").test("src/a/b.rs"));
});

test("trailers", () => {
    assert.strictEqual(trailer(body(), "Factory-Task"), "en/weekday-parser");
    assert.strictEqual(trailer("nothing", "Factory-Task"), null);
});

test("human PRs pass and are not enforced", () => {
    const r = evaluate({ isAgent: false, body: "manual change", changed: [".github/workflows/ci.yml"], protectedGlobs: PROTECTED, loadContract });
    assert.deepStrictEqual([r.ok, r.kind], [true, "human"]);
});

test("agent PR without a task fails", () => {
    const r = evaluate({ isAgent: true, body: "hi", changed: ["src/lib.rs"], protectedGlobs: PROTECTED, loadContract });
    assert.strictEqual(r.ok, false);
});

test("in-scope factory PR passes and reports golden areas", () => {
    const r = evaluate({ isAgent: true, body: body(), changed: ["src/locales/en/parsers/weekday.rs"], protectedGlobs: PROTECTED, loadContract });
    assert.deepStrictEqual(
        [r.ok, r.task, r.goldenAreas, r.goldenStep, r.differential],
        [true, "en/weekday-parser", ["en/weekday", "en/casual"], "ENWeekdayParser", { seed: 42, phrases: 2000 }]
    );
});

test("out-of-scope change fails (fire drill: auto PR touching src/core)", () => {
    const r = evaluate({
        isAgent: true,
        body: body(),
        changed: ["src/locales/en/parsers/weekday.rs", "src/core/chrono.rs"],
        protectedGlobs: PROTECTED,
        loadContract,
    });
    assert.strictEqual(r.ok, false);
    assert.match(r.reasons.join(), /out of contract scope: src\/core\/chrono.rs/);
});

test("protected path fails even if the contract scope lists it (fire drill: weakened test)", () => {
    const loose = () => ({ ...CONTRACT, scope: ["tests/golden/**", "src/**"] });
    const r = evaluate({ isAgent: true, body: body(), changed: ["tests/golden/en/weekday.json"], protectedGlobs: PROTECTED, loadContract: loose });
    assert.strictEqual(r.ok, false);
    assert.match(r.reasons.join(), /protected path changed/);
});

test("stale or missing Contract-SHA fails (fire drill: stale contract)", () => {
    const stale = evaluate({
        isAgent: true,
        body: body().replace("a1b2c3d", "deadbee"),
        changed: ["src/locales/en/parsers/weekday.rs"],
        protectedGlobs: PROTECTED,
        loadContract,
    });
    assert.match(stale.reasons.join(), /stale contract/);
    const missing = evaluate({
        isAgent: true,
        body: "Factory-Task: en/weekday-parser",
        changed: ["src/locales/en/parsers/weekday.rs"],
        protectedGlobs: PROTECTED,
        loadContract,
    });
    assert.match(missing.reasons.join(), /missing Contract-SHA/);
});

test("unknown task or bad id fails closed", () => {
    for (const task of ["en/nope", "../etc", "EN/X"]) {
        const r = evaluate({ isAgent: false, body: `Factory-Task: ${task}\nContract-SHA: a1b2c3d`, changed: ["x"], protectedGlobs: PROTECTED, loadContract });
        assert.strictEqual(r.ok, false, task);
    }
});

test("malformed acceptance fails closed", () => {
    const bad = () => ({ ...CONTRACT, acceptance: [{ golden: "tests/golden/en/weekday.json" }, { differential: { seed: "x" } }] });
    const r = evaluate({ isAgent: true, body: body(), changed: ["src/locales/en/parsers/weekday.rs"], protectedGlobs: PROTECTED, loadContract: bad });
    assert.strictEqual(r.ok, false);
    assert.match(r.reasons.join(), /unsupported golden/);
    assert.match(r.reasons.join(), /unsupported differential/);
});

test("golden acceptance with no areas fails (it would skip the contract golden step)", () => {
    const empty = () => ({ ...CONTRACT, acceptance: [{ golden: { step: "ENWeekdayParser", areas: [] } }] });
    const r = evaluate({ isAgent: true, body: body(), changed: ["src/locales/en/parsers/weekday.rs"], protectedGlobs: PROTECTED, loadContract: empty });
    assert.strictEqual(r.ok, false);
    assert.match(r.reasons.join(), /unsupported golden acceptance/);
});
