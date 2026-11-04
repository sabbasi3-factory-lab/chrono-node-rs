"use strict";
const test = require("node:test");
const assert = require("node:assert");
const lib = require("../lib");
const LOCALES = require("../../lib/locales");

test("manifest: code, module, upstream and test paths; only exported configurations", () => {
    const m = lib.manifestFor("zh-hans", ["casual", "strict", "Chrono"]);
    assert.deepStrictEqual(m, {
        generator: "harness/onboard/onboard.js",
        code: "zh-hans",
        module: "zh_hans",
        upstream: "locales/zh/hans",
        tests: "test/zh/hans",
        configs: { "zh.hans.casual": "casual", "zh.hans.strict": "strict" },
    });
    assert.deepStrictEqual(LOCALES.checkManifest(JSON.parse(lib.renderManifest(m)), "x"), m);
    assert.throws(() => lib.manifestFor("fi", ["configuration"]), /neither casual nor strict/);
    assert.throws(() => lib.manifestFor("../x", ["casual"]), /bad locale code/);
});

test("checkManifest fails closed on anything unexpected", () => {
    const good = JSON.parse(lib.renderManifest(lib.manifestFor("fi", ["casual", "strict"])));
    assert.ok(LOCALES.checkManifest(good, "x"));
    for (const bad of [
        { ...good, extra: 1 },
        { ...good, module: "de", code: "de", upstream: "locales/de", tests: "test/de", configs: { "de.casual": "casual" } },
        { ...good, upstream: "locales/sv" },
        { ...good, configs: { "fi.casual": "strict" } },
        { ...good, configs: { "sv.casual": "casual" } },
        { ...good, generator: "someone" },
    ]) {
        assert.throws(() => LOCALES.checkManifest(bad, "x"));
    }
});

test("names: rust stems, task ids and areas follow the hand-mapped tasks", () => {
    assert.strictEqual(lib.rustStem("SVTimeUnitCasualRelativeFormatParser"), "time_unit_casual_relative_format");
    assert.strictEqual(lib.rustStem("ESMonthNameLittleEndianParser"), "month_name_little_endian");
    assert.strictEqual(lib.rustStem("ZHHansDateParser"), "date");
    assert.strictEqual(lib.rustStem("FIMergeDateRangeRefiner"), "merge_date_range");
    assert.strictEqual(lib.rustStem("ITUnlikelyFormatFilter"), "unlikely_format_filter");
    assert.strictEqual(lib.kebab(lib.withoutLocalePrefix("FIWeekdayParser")), "weekday-parser");
    assert.strictEqual(lib.snake("AbstractParserWithWordBoundaryChecking"), "abstract_parser_with_word_boundary_checking");
    assert.strictEqual(lib.snake("TIME_UNIT_DICTIONARY"), "time_unit_dictionary");
    assert.strictEqual(lib.areaBucket("FICasualTimeParser", "parsers"), "casual");
    assert.strictEqual(lib.areaBucket("FITimeExpressionParser", "parsers"), "time");
    assert.strictEqual(lib.areaBucket("FITimeUnitWithinFormatParser", "parsers"), "relative");
    assert.strictEqual(lib.areaBucket("FIWeekdayParser", "parsers"), "dates");
    assert.strictEqual(lib.areaBucket("FIMergeDateTimeRefiner", "refiners"), "refiners");
});

const manifest = lib.manifestFor("xx", ["casual"]);
const file = (source, text, kind) => ({ source, name: source.split("/").pop().replace(/\.ts$/, ""), kind, text });
const localeFiles = {
    steps: [
        file("locales/xx/parsers/XXWeekdayParser.ts", 'import { WEEKDAY } from "../constants";\nexport default class XXWeekdayParser {}', "parsers"),
        file("locales/xx/parsers/XXAgoParser.ts", 'import X from "./AbstractBase";\nexport default class XXAgoParserImpl {}', "parsers"),
        file("locales/xx/refiners/XXMergeDateRangeRefiner.ts", 'import W from "../parsers/XXWeekdayParser";\nexport default class XXMergeDateRangeRefiner {}', "refiners"),
    ],
    support: [
        file("locales/xx/constants.ts", "export const WEEKDAY = {a: 1};", "constants"),
        file("locales/xx/parsers/AbstractBase.ts", 'import { WEEKDAY } from "../constants";\nexport abstract class B {}', "base"),
    ],
};
const configs = {
    "xx.casual": {
        parsers: [{ name: "ISOFormatParser" }, { name: "XXWeekdayParser" }, { name: "XXAgoParser" }],
        refiners: [{ name: "XXMergeDateRangeRefiner" }, { name: "OverlapRemovalRefiner" }],
    },
};
const baseTaskmap = { done: [], tasks: [{ step: "ISOFormatParser" }, { step: "OverlapRemovalRefiner" }] };
const constants = { source: "export const WEEKDAY = {};\nexport const PATTERN = `x`;\nexport function parseN(m) {}", module: { WEEKDAY: { a: 1, bb: 2 }, PATTERN: "(?:a|bb|\\d+)", parseN: (m) => ({ a: 1, bb: 2 })[m] ?? parseInt(m) } };

test("task map fragment: one task per new step, support tasks for what they import, sorted", () => {
    const f = lib.taskmapFragment({ manifest, configs, baseTaskmap, localeFiles, constants, goldenTexts: ["see bb 12 now"] });
    assert.deepStrictEqual(f.tasks.map((t) => t.id), ["xx/abstract-base", "xx/ago-parser", "xx/constants", "xx/merge-date-range-refiner", "xx/weekday-parser"]);
    const byId = new Map(f.tasks.map((t) => [t.id, t]));
    assert.deepStrictEqual(byId.get("xx/weekday-parser").needs, ["xx/constants"]);
    assert.deepStrictEqual(byId.get("xx/ago-parser").needs, ["xx/abstract-base"]);
    assert.strictEqual(byId.get("xx/ago-parser").class, "XXAgoParserImpl");
    assert.strictEqual(byId.get("xx/ago-parser").rust, "src/locales/xx/parsers/ago.rs");
    assert.deepStrictEqual(byId.get("xx/abstract-base").needs, ["xx/constants"]);
    assert.strictEqual(byId.get("xx/abstract-base").rust, "src/locales/xx/abstract_base.rs");
    assert.ok(byId.get("xx/abstract-base").requirement.includes("xx/ago-parser"));
    // A step importing another step needs it first (its scope is one file).
    assert.deepStrictEqual(byId.get("xx/merge-date-range-refiner").needs, ["xx/weekday-parser"]);
    assert.strictEqual(byId.get("xx/constants").kind, "support");
    // Deterministic: the same inputs render the same bytes.
    const again = lib.taskmapFragment({ manifest, configs, baseTaskmap, localeFiles, constants, goldenTexts: ["see bb 12 now"] });
    assert.strictEqual(lib.renderFragment(f), lib.renderFragment(again));
});

test("module skeleton: every scope file's directory, parsers/ and refiners/ always, nothing outside the locale", () => {
    const f = lib.taskmapFragment({ manifest, configs, baseTaskmap, localeFiles, constants, goldenTexts: ["see bb 12 now"] });
    const sk = lib.moduleSkeleton(manifest, f);
    assert.deepStrictEqual([...sk.keys()], ["src/locales/xx/parsers/.gitkeep", "src/locales/xx/refiners/.gitkeep"]);
    assert.ok([...sk.values()].every((v) => v === ""));
    const dirs = new Set(["src/locales/xx", ...[...sk.keys()].map((k) => k.replace(/\/\.gitkeep$/, ""))]);
    assert.deepStrictEqual(lib.missingScopeParents(f.tasks.map((t) => t.rust), (d) => dirs.has(d)), []);
    // A refiners-only (or parsers-only) locale still gets both; a nested scope gets each level.
    const nested = { tasks: [{ id: "xx/a", rust: "src/locales/xx/parsers/sub/a.rs" }] };
    assert.deepStrictEqual([...lib.moduleSkeleton(manifest, nested).keys()], [
        "src/locales/xx/parsers/.gitkeep",
        "src/locales/xx/parsers/sub/.gitkeep",
        "src/locales/xx/refiners/.gitkeep",
    ]);
    for (const rust of ["src/locales/yy/parsers/a.rs", "src/locales/xx/../yy/a.rs", "src/core/a.rs"]) {
        assert.throws(() => lib.moduleSkeleton(manifest, { tasks: [{ id: "xx/a", rust }] }), /outside src\/locales\/xx\//);
    }
    // Without the skeleton, every step's scope file would need a mkdir.
    assert.deepStrictEqual(lib.missingScopeParents(["src/locales/xx/parsers/a.rs", "src/locales/xx/constants.rs"], (d) => d === "src/locales/xx"), ["src/locales/xx/parsers/a.rs"]);
});

test("onboard.yml keeps the skeleton's hidden files in the generate job's artifact", () => {
    const fs = require("fs");
    const path = require("path");
    const YAML = require("yaml");
    const wf = YAML.parse(fs.readFileSync(path.join(__dirname, "../../../.github/workflows/onboard.yml"), "utf8"));
    const files = ["src/locales/xx/mod.rs", "src/locales/xx/parsers/.gitkeep"];
    assert.deepStrictEqual(lib.workflowProblems(wf, files), []);
    // Bites: the default upload drops dotfiles, so apply's file-list check would fail live.
    const upload = Object.values(wf.jobs).flatMap((j) => j.steps || []).find((st) => st.with && st.with.name === "onboard");
    delete upload.with["include-hidden-files"];
    assert.match(lib.workflowProblems(wf, files)[0], /drops hidden files/);
    assert.deepStrictEqual(lib.workflowProblems(wf, ["src/locales/xx/mod.rs"]), []);
});

test("task map fragment fails closed on a step that's neither the locale's file nor mapped", () => {
    const other = { "xx.casual": { parsers: [{ name: "ENWeekdayParser" }], refiners: [] } };
    assert.throws(() => lib.taskmapFragment({ manifest, configs: other, baseTaskmap, localeFiles, constants, goldenTexts: [] }), /ENWeekdayParser .* a hand decision/);
});

test("constants unit cases: exact patterns and dictionaries, calls with distinct results per input kind", () => {
    const u = lib.constantsUnit(manifest, constants, ["see bb 12 now"]);
    const byTest = new Map(u.cases.map((c) => [c.test, c]));
    assert.deepStrictEqual(byTest.get("weekday_matches_upstream"), { test: "weekday_matches_upstream", kind: "map", export: "WEEKDAY", expect: { a: 1, bb: 2 } });
    assert.strictEqual(byTest.get("pattern_matches_upstream").expect, "(?:a|bb|\\d+)");
    const calls = u.cases.filter((c) => c.kind === "call");
    // Round-robin: golden-text matches ("12", "bb"), dictionary words ("a", "bb"), numerals.
    assert.deepStrictEqual(calls.slice(0, 2).map((c) => [c.input, c.expect]), [["12", 12], ["a", 1]]);
    assert.ok(calls.length <= 8);
    assert.ok(new Set(calls.map((c) => c.test)).size === calls.length);
    assert.ok(u.requirement.includes("CI checks the names"));
});

test("configuration.rs: slots in order with flags, rustfmt-stable long lines", () => {
    const rs = lib.renderConfigurationRs(manifest, {
        "xx.casual": {
            parsers: [{ name: "XXWeekdayParser", flags: {} }, { name: "XXTimeUnitCasualRelativeFormatParserWithAVeryLongNameIndeed", flags: { allowAbbreviations: true, strictMode: false } }],
            refiners: [{ name: "OverlapRemovalRefiner", flags: {} }],
        },
    });
    assert.ok(rs.includes('    c.push_parser("XXWeekdayParser", Flags::none());'));
    assert.ok(rs.includes('        Flags::of(&[("allowAbbreviations", true), ("strictMode", false)]),'));
    assert.ok(rs.includes('    c.push_refiner("OverlapRemovalRefiner", Flags::none());'));
    for (const line of rs.split("\n")) assert.ok(line.length <= 120, line);
});

const policy = { languages: ["fi", "id"], max_languages_in_flight: 1, stop: { budget_aic: 1000, min_first_try_merge_rate: 0.8, min_sample: 2, max_open_needs_human: 2 } };
const run = (task, workflow, aic, accepted, zero = true) => ({ task, workflow, aic, items: [{ type: "create_pull_request", outcome_status: accepted ? "accepted" : "pending", zero_touch: zero }] });

test("next language: policy order, one at a time, waits on open PRs and in-flight tasks", () => {
    const base = { policy, onboarded: [], candidates: ["ar", "fi", "id"], outcomes: { runs: [] }, issues: [], openPRs: [] };
    assert.deepStrictEqual(lib.nextLanguage(base), { action: "onboard", code: "fi", spent: 0, first_try: "0/0" });
    assert.strictEqual(lib.nextLanguage({ ...base, openPRs: ["fi"] }).action, "wait");
    const inFlight = { ...base, onboarded: ["fi"], candidates: ["ar", "id"], issues: [{ id: "fi/weekday-parser", labels: [] }] };
    assert.deepStrictEqual(lib.nextLanguage(inFlight), { action: "wait", reason: "in_flight:fi" });
    assert.strictEqual(lib.nextLanguage({ ...inFlight, issues: [] }).code, "id");
    assert.deepStrictEqual(lib.nextLanguage({ ...base, candidates: ["ar"] }), { action: "stop", reason: "all_onboarded" });
});

test("next language: stop rules (budget, first-try rate, needs-human cluster) and fail closed", () => {
    const base = { policy, onboarded: ["fi"], candidates: ["id"], issues: [], openPRs: [] };
    assert.deepStrictEqual(lib.nextLanguage({ ...base, policy: null, outcomes: { runs: [] } }), { action: "stop", reason: "no_onboarding_policy" });
    assert.deepStrictEqual(lib.nextLanguage({ ...base, outcomes: null }), { action: "wait", reason: "outcomes_unreadable" });
    const spent = { runs: [run("fi/a", "implement", 600, true), run("fi/b", "implement", 450, true), run("sv/x", "implement", 5000, true)] };
    assert.deepStrictEqual(lib.nextLanguage({ ...base, outcomes: spent }), { action: "stop", reason: "budget_spent:1050/1000" });
    const repaired = { runs: [run("fi/a", "implement", 10, true), run("fi/b", "implement", 10, true), run("fi/b", "repair", 10, true)] };
    assert.deepStrictEqual(lib.nextLanguage({ ...base, outcomes: repaired }), { action: "stop", reason: "first_try_rate:1/2" });
    const good = { runs: [run("fi/a", "implement", 10, true), run("fi/b", "implement", 10, true)] };
    assert.strictEqual(lib.nextLanguage({ ...base, outcomes: good }).code, "id");
    const nh = [{ id: "fi/a", labels: ["needs-human"] }, { id: "fi/b", labels: ["needs-human"] }];
    assert.deepStrictEqual(lib.nextLanguage({ ...base, outcomes: good, issues: nh }), { action: "stop", reason: "needs_human_cluster:2" });
    assert.deepStrictEqual(lib.nextLanguage({ ...base, outcomes: good, policy: { ...policy, stop: {} } }), { action: "stop", reason: "no_budget" });
    // A run without a known cost: the spend is unknown, so wait (never count it as zero).
    assert.deepStrictEqual(lib.nextLanguage({ ...base, outcomes: { runs: [...good.runs, { ...run("fi/c", "implement", 0, false), aic: null }] } }), { action: "wait", reason: "spend_unknown" });
});
