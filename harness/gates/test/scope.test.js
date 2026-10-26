"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { globToRegExp, evaluate, trailer, needsFullRegression } = require("../scope");

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

test("protected paths are reported even without a task, a valid id or a contract (all violations, fail closed)", () => {
    const changed = ["upstream/PINNED.md", "src/locales/en/parsers/month_name.rs", ".github/workflows/ci.yml"];
    const expectProtected = (r) => {
        assert.strictEqual(r.ok, false);
        assert.match(r.reasons.join("\n"), /protected path changed: upstream\/PINNED.md/);
        assert.match(r.reasons.join("\n"), /protected path changed: .github\/workflows\/ci.yml/);
    };
    // no contract on the base branch
    let r = evaluate({ isAgent: false, body: "Factory-Task: en/month-name-parser\nContract-SHA: 0000000", changed, protectedGlobs: PROTECTED, loadContract });
    expectProtected(r);
    assert.match(r.reasons.join("\n"), /no contract contracts\/en\/month-name-parser.yaml/);
    // malformed task id
    r = evaluate({ isAgent: false, body: "Factory-Task: ../x", changed, protectedGlobs: PROTECTED, loadContract });
    expectProtected(r);
    assert.match(r.reasons.join("\n"), /invalid Factory-Task id/);
    // agent PR without a task
    r = evaluate({ isAgent: true, body: "no trailers", changed, protectedGlobs: PROTECTED, loadContract });
    expectProtected(r);
    assert.match(r.reasons.join("\n"), /agent PR without Factory-Task trailer/);
});

test("with a contract, protected and out-of-scope paths and a stale SHA are all reported together", () => {
    const r = evaluate({
        isAgent: true,
        body: body().replace("a1b2c3d", "deadbee"),
        changed: ["contracts/en/weekday-parser.yaml", "src/core/chrono.rs", "src/locales/en/parsers/weekday.rs"],
        protectedGlobs: PROTECTED,
        loadContract,
    });
    assert.strictEqual(r.ok, false);
    const all = r.reasons.join("\n");
    assert.match(all, /protected path changed: contracts\/en\/weekday-parser.yaml/);
    assert.match(all, /out of contract scope: src\/core\/chrono.rs/);
    assert.match(all, /stale contract/);
    assert.doesNotMatch(all, /out of contract scope: contracts/); // reported once, as protected
});

test("full regression: auto-strict paths or contract tier; fail closed without the policy list", () => {
    const STRICT = ["src/core/**", "src/calculation/**", "src/common/**", "Cargo.toml", "Cargo.lock", "vendor/**"];
    const run = (changed, contractTier = null, autoStrictGlobs = STRICT) => needsFullRegression({ changed, autoStrictGlobs, contractTier });
    assert.strictEqual(run(["src/locales/en/parsers/weekday.rs"]), false);
    assert.strictEqual(run(["src/locales/en/parsers/weekday.rs", "src/core/results.rs"]), true);
    assert.strictEqual(run(["src/common/refiners/merge.rs"]), true);
    assert.strictEqual(run(["Cargo.lock"]), true);
    assert.strictEqual(run(["src/locales/en/parsers/x.rs"], "auto-strict"), true, "contract tier");
    assert.strictEqual(run(["src/locales/en/parsers/x.rs"], "auto"), false);
    assert.strictEqual(run(["src/locales/en/parsers/x.rs"], null, []), true, "no auto-strict paths in the policy: fail closed");
    assert.strictEqual(needsFullRegression({ changed: ["src/locales/en/parsers/x.rs"], autoStrictGlobs: undefined, contractTier: null }), true);
    // Mixed scope: a tier-auto contract that may touch src/core is auto-strict to the controller, so CI
    // runs the full regression even when the PR changes only the test file.
    assert.strictEqual(needsFullRegression({ changed: ["tests/locales/en/results.rs"], autoStrictGlobs: STRICT, contractTier: "auto", contractScope: ["src/core/results.rs", "tests/locales/en/results.rs"] }), true);
    assert.strictEqual(needsFullRegression({ changed: ["tests/locales/en/results.rs"], autoStrictGlobs: STRICT, contractTier: "auto", contractScope: ["tests/locales/en/results.rs"] }), false);
});

test("a controller auto-revert PR is a person's kind of PR to the strict gates (advisory semver, no agent gates)", () => {
    // The body the controller's open_revert writes (executor.ts): no Factory-Task trailer, and the
    // author is the controller App, not the agent. So kind=human: a revert that removes public API
    // added by the reverted change isn't blocked by semver_checks (advisory), in the PR, the merge
    // queue or the post-merge run on main.
    const body = "**Factory controller** · auto-revert\n\nReverts #21 (task `core/results`): `ci` failed on main at its merge commit `" + "f".repeat(40) + "` (run 900).";
    const r = evaluate({ isAgent: false, body, changed: ["src/core/results.rs"], protectedGlobs: PROTECTED, loadContract });
    assert.strictEqual(r.kind, "human");
    assert.strictEqual(r.ok, true);
});
