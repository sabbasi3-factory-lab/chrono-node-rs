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
const NOW = "2026-11-06T12:00:00Z";
const L = (run_id, title, created_at, conclusion = "success", workflow = title.split(" ")[0].toLowerCase()) => ({ run_id, workflow, title, conclusion, created_at });
const M = (task, number, created_at, zero_touch = true) => ({ task, number, created_at, zero_touch });
const spend = (run_id, aic, extra = {}) => ({ type: "run_spend", payload: { dry_run: false, run_id, aic, status: "measured", ...extra } });
const costsOf = (...events) => lib.runCosts(events);
// fi done: two tasks, each one implement run, merged zero-touch, 10 AIC each.
const fiDone = () => ({
    policy,
    onboarded: ["fi"],
    candidates: ["id"],
    issues: [{ id: "fi/a", state: "closed", labels: [] }, { id: "fi/b", state: "closed", labels: [] }],
    openPRs: [],
    contracts: ["fi/a", "fi/b"],
    onboardMerges: [{ code: "fi", merged_at: "2026-11-04T19:00:00Z" }],
    ledger: { runs: [L(20, "Implement fi/a #1 attempt 1", "2026-11-04T20:00:00Z"), L(21, "Implement fi/b #2 attempt 1", "2026-11-04T20:05:00Z")], merged: [M("fi/a", 30, "2026-11-04T20:30:00Z"), M("fi/b", 31, "2026-11-04T20:35:00Z")] },
    costs: costsOf(spend(20, 10), spend(21, 10)),
    now: NOW,
});

test("next language: policy order, one at a time, waits on open PRs and in-flight tasks", () => {
    const base = { policy, onboarded: [], candidates: ["ar", "fi", "id"], issues: [], openPRs: [], contracts: [], onboardMerges: [], ledger: { runs: [], merged: [] }, costs: new Map(), now: NOW };
    assert.deepStrictEqual(lib.nextLanguage(base), { action: "onboard", code: "fi", spent: 0, first_try: "0/0" });
    assert.strictEqual(lib.nextLanguage({ ...base, openPRs: ["fi"] }).action, "wait");
    const done = fiDone();
    assert.deepStrictEqual(lib.nextLanguage(done), { action: "onboard", code: "id", spent: 20, first_try: "2/2" });
    const inFlight = { ...done, issues: [...done.issues.slice(1), { id: "fi/a", state: "open", labels: [] }] };
    assert.deepStrictEqual(lib.nextLanguage(inFlight), { action: "wait", reason: "in_flight:fi" });
    // A missing state counts as open.
    assert.strictEqual(lib.nextLanguage({ ...done, issues: [...done.issues, { id: "fi/c", labels: [] }] }).reason, "in_flight:fi");
    assert.deepStrictEqual(lib.nextLanguage({ ...base, candidates: ["ar"] }), { action: "stop", reason: "all_onboarded" });
});

test("next language: several in flight (max_languages_in_flight 5, owner 2026-11-09): onboards the next while others run", () => {
    const multi = { ...policy, languages: ["fi", "id", "nl", "ru"], max_languages_in_flight: 5 };
    const done = fiDone();
    const fiOpen = { ...done, policy: multi, candidates: ["id", "nl", "ru"], issues: [...done.issues.slice(1), { id: "fi/a", state: "open", labels: [] }] };
    // fi in flight: id onboards on this decision (one language per decision, policy order).
    assert.strictEqual(lib.nextLanguage(fiOpen).code, "id");
    // The next decision, with id's onboarding PR still open: wait for it (onboarding PRs go one at a time).
    assert.deepStrictEqual(lib.nextLanguage({ ...fiOpen, openPRs: ["id"] }), { action: "wait", reason: "onboarding_pr_open:id" });
    // id merged, its issues not created yet: wait (pending), whatever else is in flight.
    const idMerged = { ...fiOpen, onboarded: ["fi", "id"], candidates: ["nl", "ru"], contracts: [...done.contracts, "id/a"], onboardMerges: [...done.onboardMerges, { code: "id", merged_at: "2026-11-06T11:30:00Z" }] };
    assert.deepStrictEqual(lib.nextLanguage(idMerged), { action: "wait", reason: "task_issues_pending:id" });
    // id's issues exist: fi and id in flight, nl onboards on the following decision.
    const both = { ...idMerged, issues: [...idMerged.issues, { id: "id/a", state: "open", labels: [] }] };
    assert.strictEqual(lib.nextLanguage(both).code, "nl");
    // A missing issue in one language past its grace still stops everything (alert), as with one in flight.
    assert.deepStrictEqual(lib.nextLanguage({ ...idMerged, now: "2026-11-06T14:00:00Z" }), { action: "stop", reason: "task_issues_missing:id" });
    // The limit still binds when reached, naming every language in flight.
    const two = { ...both, policy: { ...multi, max_languages_in_flight: 2 } };
    assert.deepStrictEqual(lib.nextLanguage(two), { action: "wait", reason: "in_flight:fi,id" });
    // The stop rules aggregate across every language in flight (one needs-human each is a cluster of 2).
    const nh = { ...both, issues: [{ id: "fi/a", state: "open", labels: ["needs-human"] }, { id: "fi/b", state: "closed", labels: [] }, { id: "id/a", state: "open", labels: ["needs-human"] }] };
    assert.deepStrictEqual(lib.nextLanguage(nh), { action: "stop", reason: "needs_human_cluster:2" });
});

test("next language: a contract without its task issue is in flight; past the grace period it stops (alert)", () => {
    const done = fiDone();
    const unissued = { ...done, issues: done.issues.slice(1) };
    // Just merged: the issues jobs are still running.
    assert.deepStrictEqual(lib.nextLanguage({ ...unissued, now: "2026-11-04T20:00:00Z" }), { action: "wait", reason: "task_issues_pending:fi" });
    // Past the grace period, or no record of the onboarding merge: stop.
    assert.deepStrictEqual(lib.nextLanguage(unissued), { action: "stop", reason: "task_issues_missing:fi" });
    assert.deepStrictEqual(lib.nextLanguage({ ...unissued, onboardMerges: [], now: "2026-11-04T20:00:00Z" }), { action: "stop", reason: "task_issues_missing:fi" });
    // Every issue gone (none created at all) is the same.
    assert.deepStrictEqual(lib.nextLanguage({ ...done, issues: [] }), { action: "stop", reason: "task_issues_missing:fi" });
    // Unreadable inputs wait.
    assert.deepStrictEqual(lib.nextLanguage({ ...done, contracts: null }), { action: "wait", reason: "inputs_unreadable:contracts" });
    assert.deepStrictEqual(lib.nextLanguage({ ...done, onboardMerges: null }), { action: "wait", reason: "inputs_unreadable:onboard_merges" });
    assert.deepStrictEqual(lib.nextLanguage({ ...done, issues: null }), { action: "wait", reason: "inputs_unreadable:issues" });
    assert.deepStrictEqual(lib.nextLanguage({ ...done, openPRs: undefined }), { action: "wait", reason: "inputs_unreadable:prs" });
    // Other locales' contracts (hand-ported, not generated) are not this rule's.
    assert.strictEqual(lib.nextLanguage({ ...done, contracts: [...done.contracts, "en/x"] }).code, "id");
});

test("next language: stop rules (budget, first-try rate, needs-human cluster)", () => {
    const done = fiDone();
    assert.deepStrictEqual(lib.nextLanguage({ ...done, policy: null }), { action: "stop", reason: "no_onboarding_policy" });
    assert.deepStrictEqual(lib.nextLanguage({ ...done, costs: costsOf(spend(20, 600), spend(21, 450)) }), { action: "stop", reason: "budget_spent:1050/1000" });
    const repaired = { ...done, ledger: { ...done.ledger, runs: [...done.ledger.runs, L(22, "Repair fi/b #2 attempt 2", "2026-11-04T20:40:00Z")] }, costs: costsOf(spend(20, 10), spend(21, 10), spend(22, 10)) };
    assert.deepStrictEqual(lib.nextLanguage(repaired), { action: "stop", reason: "first_try_rate:1/2" });
    const touched = { ...done, ledger: { ...done.ledger, merged: [M("fi/a", 30, "2026-11-04T20:30:00Z"), M("fi/b", 31, "2026-11-04T20:35:00Z", false)] } };
    assert.deepStrictEqual(lib.nextLanguage(touched), { action: "stop", reason: "first_try_rate:1/2" });
    const nh = [{ id: "fi/a", state: "open", labels: ["needs-human"] }, { id: "fi/b", state: "open", labels: ["needs-human"] }];
    assert.deepStrictEqual(lib.nextLanguage({ ...done, issues: nh }), { action: "stop", reason: "needs_human_cluster:2" });
    assert.deepStrictEqual(lib.nextLanguage({ ...done, policy: { ...policy, stop: {} } }), { action: "stop", reason: "no_budget" });
});

test("next language fails closed when the records lag the ledger (#317: id onboarded on 0 AIC, 0/0 with fi done)", () => {
    const ledgerRuns = [
        L(10, "Review one factory PR", "2026-10-27T10:00:00Z"), // before any generated-locale run: not ours
        L(11, "Implement sv/weekday-parser #9 attempt 1", "2026-10-28T10:00:00Z"), // not a generated locale
        L(20, "Implement fi/a #1 attempt 1", "2026-11-04T20:00:00Z"),
        L(21, "Implement fi/b #2 attempt 1", "2026-11-04T20:05:00Z", "failure"),
        L(22, "Implement fi/b #2 attempt 2", "2026-11-04T23:00:00Z"),
        L(23, "Review one factory PR", "2026-11-04T21:00:00Z"),
        L(24, "Implement fi/c #3 attempt 1", "2026-11-04T23:10:00Z", "skipped"),
    ];
    const merged = [M("fi/a", 30, "2026-11-04T20:30:00Z"), M("fi/b", 31, "2026-11-04T23:20:00Z"), M("sv/weekday-parser", 5, "2026-10-28T11:00:00Z")];
    const full = costsOf(spend(20, 10), spend(21, 10), spend(22, 10), spend(23, 5));
    const base = { ...fiDone(), ledger: { runs: ledgerRuns, merged } };
    // Complete: the real numbers (spend 35, first try 1/2) stop it.
    assert.deepStrictEqual(lib.nextLanguage({ ...base, costs: full }), { action: "stop", reason: "first_try_rate:1/2" });
    // No cost on record for any of fi's runs: wait, never onboard on 0 AIC.
    const empty = lib.nextLanguage({ ...base, costs: new Map() });
    assert.deepStrictEqual([empty.action, empty.reason, empty.behind], ["wait", "records_behind:4", ["run:20", "run:21", "run:22", "run:23"]]);
    // One run missing is enough to wait.
    assert.strictEqual(lib.nextLanguage({ ...base, costs: costsOf(spend(20, 10), spend(22, 10), spend(23, 5)) }).reason, "records_behind:1");
    // A merged task whose zero-touch verdict is unknown (a list was truncated) waits too.
    const unknown = { ...base, costs: full, ledger: { runs: ledgerRuns, merged: [merged[0], { ...merged[1], zero_touch: null }] } };
    assert.deepStrictEqual(lib.nextLanguage(unknown).behind, ["merged:fi/b"]);
    // Unreadable inputs wait; they never read as "nothing".
    assert.deepStrictEqual(lib.nextLanguage({ ...base, costs: full, ledger: null }), { action: "wait", reason: "ledger_unreadable" });
    assert.deepStrictEqual(lib.nextLanguage({ ...base, costs: full, ledger: { runs: ledgerRuns } }), { action: "wait", reason: "ledger_unreadable" });
    assert.deepStrictEqual(lib.nextLanguage({ ...base, costs: null }), { action: "wait", reason: "costs_unreadable" });
    // A review since the first generated-locale run counts toward the spend (it names no task).
    assert.deepStrictEqual(lib.nextLanguage({ ...base, costs: costsOf(spend(20, 10), spend(21, 10), spend(22, 10), spend(23, 2000)) }), { action: "stop", reason: "budget_spent:2030/1000" });
    // The agentic canary's review runs (`Review drill/…`) are never ours.
    const canary = { ...base, ledger: { runs: [...ledgerRuns, L(25, "Review drill/activation-canary PR #1", "2026-11-05T05:23:00Z", "failure")], merged } };
    assert.deepStrictEqual(lib.nextLanguage({ ...canary, costs: full }), { action: "stop", reason: "first_try_rate:1/2" });
    // No generated locale yet: nothing to cover.
    assert.strictEqual(lib.nextLanguage({ ...base, onboarded: [], candidates: ["fi", "id"], costs: new Map() }).code, "fi");
});

test("runCosts: newest run_spend wins; snapshot entries only for runs without one; bounded runs at their evidence", () => {
    const snap = (runs, dry_run = false) => ({ type: "spend_snapshot", payload: { dry_run, runs } });
    const c = lib.runCosts([
        snap([{ run_id: 1, status: "reserved", aic: 2600 }, { run_id: 2, status: "reserved", aic: 2600 }, { run_id: 3, status: "measured", aic: 7 }]),
        spend(1, 30),
        spend(1, 31),
        snap([{ run_id: 2, status: "bounded", aic: 2600, readable_aic: 22.5, observed_aic: 21.3 }]),
        spend(4, 2600, { status: "bounded", reason: "usage_file_missing", observed_aic: 46.5 }),
        spend(5, 2600, { status: "bounded", reason: "usage_file_missing" }),
        spend(6, 99, { dry_run: true }),
        snap([{ run_id: 7, status: "reserved", aic: 2600 }]),
    ]);
    assert.deepStrictEqual(
        [...c].map(([id, x]) => [id, x.aic, x.source]).sort((a, b) => a[0] - b[0]),
        [[1, 31, "run_spend"], [2, 22.5, "spend_snapshot"], [3, 7, "spend_snapshot"], [4, 46.5, "run_spend"], [5, 2600, "run_spend"], [7, 2600, "spend_snapshot"]],
    );
});

test("zeroTouch: gh-aw's verdict from a merged PR's comments, reviews and commits", () => {
    const bot = { __typename: "Bot", login: "copilot-pull-request-reviewer" };
    const person = { __typename: "User", login: "sabbasi3" };
    const agentCommit = { commit: { author: { email: "1+sabbasi3-factory-agent[bot]@users.noreply.github.com", user: null } } };
    const pr = (over = {}) => ({ comments: { nodes: [{ author: bot }] }, reviews: { nodes: [{ author: bot }] }, commits: { nodes: [agentCommit] }, ...over });
    assert.strictEqual(lib.zeroTouch(pr()), true);
    assert.strictEqual(lib.zeroTouch(pr({ comments: { nodes: [{ author: person }] } })), false);
    assert.strictEqual(lib.zeroTouch(pr({ reviews: { nodes: [{ author: person }] } })), false);
    assert.strictEqual(lib.zeroTouch(pr({ commits: { nodes: [agentCommit, { commit: { author: { email: "me@example.com", user: { login: "sabbasi3" } } } }] } })), false);
    // An unknown author is a person (stricter); a deleted account too.
    assert.strictEqual(lib.zeroTouch(pr({ commits: { nodes: [{ commit: { author: { email: "x@example.com", user: null } } }] } })), false);
    assert.strictEqual(lib.zeroTouch(pr({ comments: { nodes: [{ author: null }] } })), false);
    // A truncated or missing list: can't tell.
    assert.strictEqual(lib.zeroTouch(pr({ comments: { pageInfo: { hasNextPage: true }, nodes: [] } })), null);
    assert.strictEqual(lib.zeroTouch(pr({ commits: undefined })), null);
});

test("next CLI: a missing or empty input file waits (never 'none')", () => {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const { spawnSync } = require("child_process");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "next-"));
    const w = (f, t) => fs.writeFileSync(path.join(dir, f), t);
    w("policy.yaml", "languages: [zz]\nstop: {budget_aic: 10}\n");
    w("audit.jsonl", "\n");
    for (const f of ["issues", "prs", "onboard-merges", "runs", "merged"]) w(`${f}.json`, "[]");
    const next = (over = {}) => {
        const args = ["policy.yaml", "issues.json", "prs.json", "onboard-merges.json", "runs.json", "merged.json", "audit.jsonl"].flatMap((f) => [`--${f.replace(/\.(json|jsonl|yaml)$/, "")}`, path.join(dir, over[f] ?? f)]);
        const r = spawnSync(process.execPath, [path.join(__dirname, "../onboard.js"), "next", ...args], { encoding: "utf8" });
        return JSON.parse(r.stdout);
    };
    assert.ok(!/unreadable/.test(next().reason), next().reason);
    w("empty", "");
    w("object.json", "{}");
    assert.deepStrictEqual(next({ "issues.json": "empty" }), { action: "wait", reason: "inputs_unreadable:issues" });
    assert.deepStrictEqual(next({ "prs.json": "absent.json" }), { action: "wait", reason: "inputs_unreadable:prs" });
    assert.deepStrictEqual(next({ "onboard-merges.json": "empty" }).reason, "inputs_unreadable:onboard_merges");
    assert.deepStrictEqual(next({ "runs.json": "empty" }), { action: "wait", reason: "ledger_unreadable" });
    assert.deepStrictEqual(next({ "merged.json": "object.json" }), { action: "wait", reason: "ledger_unreadable" });
    assert.deepStrictEqual(next({ "audit.jsonl": "empty" }), { action: "wait", reason: "costs_unreadable" });
    fs.rmSync(dir, { recursive: true, force: true });
});

test("next language: a recorded infra incident excuses the failed attempts before it (first-try rate only)", () => {
    // fi/b: attempt 1 broke on a factory defect (no PR), attempt 2 after the re-drive merged zero-touch.
    const done = fiDone();
    const runs = [L(20, "Implement fi/a #1 attempt 1", "2026-11-04T20:00:00Z"), L(21, "Implement fi/b #2 attempt 1", "2026-11-04T20:23:00Z", "failure"), L(22, "Implement fi/b #2 attempt 2", "2026-11-04T23:28:00Z")];
    const merged = [M("fi/a", 30, "2026-11-04T20:30:00Z"), M("fi/b", 31, "2026-11-04T23:40:00Z")];
    const base = { ...done, ledger: { runs, merged }, costs: costsOf(spend(20, 10), spend(21, 10), spend(22, 10)) };
    assert.deepStrictEqual(lib.nextLanguage(base), { action: "stop", reason: "first_try_rate:1/2" });
    const incidents = [{ task: "fi/b", labeled_at: "2026-11-04T23:25:00Z" }];
    assert.deepStrictEqual(lib.nextLanguage({ ...base, incidents }), { action: "onboard", code: "id", spent: 30, first_try: "2/2" });
    // Narrow: an incident on another task, or recorded before the failed attempt, excuses nothing.
    assert.strictEqual(lib.nextLanguage({ ...base, incidents: [{ task: "fi/a", labeled_at: "2026-11-04T23:25:00Z" }] }).reason, "first_try_rate:1/2");
    assert.strictEqual(lib.nextLanguage({ ...base, incidents: [{ task: "fi/b", labeled_at: "2026-11-04T20:00:00Z" }] }).reason, "first_try_rate:1/2");
    // Never excuses the attempt whose PR merged: an incident after it leaves that one run counted.
    assert.strictEqual(lib.nextLanguage({ ...base, incidents: [{ task: "fi/b", labeled_at: "2026-11-05T01:00:00Z" }] }).first_try, "2/2");
    // Never excuses a repair; spend always counts every run.
    const repaired = { ...base, ledger: { runs: [...runs, L(23, "Repair fi/b #2 attempt 3", "2026-11-04T23:35:00Z")], merged }, costs: costsOf(spend(20, 10), spend(21, 10), spend(22, 10), spend(23, 10)) };
    assert.strictEqual(lib.nextLanguage({ ...repaired, incidents }).reason, "first_try_rate:1/2");
    assert.strictEqual(lib.nextLanguage({ ...base, costs: costsOf(spend(20, 10), spend(21, 995), spend(22, 10)), incidents }).reason, "budget_spent:1015/1000");
});

// ---- external locales (factory onboarding.yaml external_locales, owner 2026-11-09: vi)

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const EXT = require("../../lib/external");

test("external locales: parsed strictly from the policy text; anything unreadable throws (no issues)", () => {
    assert.deepStrictEqual(EXT.parseExternal("version: 1\nlanguages: [fi]\n# comment\nexternal_locales: [vi]\n"), ["vi"]);
    assert.deepStrictEqual(EXT.parseExternal("version: 1\nexternal_locales: [vi, zh-hant] # two\n"), ["vi", "zh-hant"]);
    assert.deepStrictEqual(EXT.parseExternal("version: 1\nexternal_locales: []\n"), []);
    assert.deepStrictEqual(EXT.parseExternal("version: 1\nlanguages: [fi]\n"), []);
    for (const bad of ["", "languages: [fi]\n", "version: 1\nexternal_locales:\n  - vi\n", "version: 1\nexternal_locales: [VI]\n", "version: 1\nexternal_locales: [vi]\nexternal_locales: []\n", "version: 1\nexternal_locales: vi\n"]) {
        assert.throws(() => EXT.parseExternal(bad), /onboarding policy/, JSON.stringify(bad));
    }
    assert.throws(() => EXT.readExternal(null), /missing/);
    assert.throws(() => EXT.readExternal(path.join(os.tmpdir(), "no-such-policy.yaml")), /missing/);
});

test("issues: with vi generated on main and external, no vi task issue is planned (others are)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ext-issues-"));
    const gen = (code) => {
        fs.mkdirSync(path.join(root, "src/locales", code), { recursive: true });
        fs.writeFileSync(path.join(root, "src/locales", code, "locale.json"), JSON.stringify({ generator: "harness/onboard/onboard.js", code, module: code, upstream: `locales/${code}`, tests: `test/${code}`, configs: { [`${code}.casual`]: "casual", [`${code}.strict`]: "strict" } }));
        fs.mkdirSync(path.join(root, "contracts", code), { recursive: true });
        for (const t of ["constants", "weekday-parser", "fix-0123abcd"]) fs.writeFileSync(path.join(root, "contracts", code, `${t}.yaml`), "id: x\n");
    };
    gen("ar");
    gen("vi");
    gen("it");
    const { generatedIds } = require("../issues");
    const policy = fs.readFileSync(path.join(__dirname, "fixtures", "onboarding-external.yaml"), "utf8");
    // The pinned policy: vi (A/B) and it (the factory v2 pilot) are both external, so neither gets issues.
    assert.deepStrictEqual(EXT.parseExternal(policy), ["vi", "it"]);
    assert.deepStrictEqual(generatedIds(root, new Set(EXT.parseExternal(policy))), ["ar/constants", "ar/weekday-parser"]);
    // Without the exclusion vi would be planned: the policy is what keeps it out.
    assert.deepStrictEqual(generatedIds(root, new Set()).filter((id) => id.startsWith("vi/")), ["vi/constants", "vi/weekday-parser"]);
    fs.rmSync(root, { recursive: true, force: true });
});

test("next language: an external locale is never returned, and never counted in flight or in the stop rules", () => {
    const ext = { ...policy, languages: ["fi", "vi", "id"], max_languages_in_flight: 1, external_locales: ["vi"] };
    const done = fiDone();
    // vi listed before id and not onboarded: skipped, id onboards.
    assert.strictEqual(lib.nextLanguage({ ...done, policy: ext, candidates: ["vi", "id"] }).code, "id");
    // Only vi left: never onboarded.
    assert.deepStrictEqual(lib.nextLanguage({ ...done, policy: ext, candidates: ["vi"] }), { action: "stop", reason: "all_onboarded" });
    // vi generated on main: its open issues, contracts without issues, runs, merges and needs-human count for nothing.
    const viOnMain = {
        ...done,
        policy: ext,
        onboarded: ["fi", "vi"],
        candidates: ["id"],
        issues: [...done.issues, { id: "vi/a", state: "open", labels: ["needs-human"] }, { id: "vi/b", state: "open", labels: ["needs-human"] }],
        contracts: [...done.contracts, "vi/a", "vi/b", "vi/c"],
        ledger: { runs: [...done.ledger.runs, L(40, "Implement vi/a #9 attempt 1", "2026-11-05T10:00:00Z"), L(41, "Repair vi/a #9 attempt 2", "2026-11-05T11:00:00Z")], merged: [...done.ledger.merged, M("vi/a", 50, "2026-11-05T12:00:00Z", false)] },
        costs: costsOf(spend(20, 10), spend(21, 10), spend(40, 5000), spend(41, 5000)),
    };
    assert.deepStrictEqual(lib.nextLanguage(viOnMain), { action: "onboard", code: "id", spent: 20, first_try: "2/2" });
    // The pinned policy itself: it (factory v2 pilot) is neither listed nor picked, even as the only
    // candidate left, and zh-hant is the last language v1 onboards.
    const YAML = require("yaml");
    const pinned = YAML.parse(fs.readFileSync(path.join(__dirname, "fixtures", "onboarding-external.yaml"), "utf8"));
    assert.ok(!pinned.languages.includes("it") && pinned.external_locales.includes("it"));
    assert.strictEqual(pinned.languages[pinned.languages.length - 1], "zh-hant");
    assert.deepStrictEqual(lib.nextLanguage({ ...done, policy: { ...pinned, languages: ["fi", "it"] }, candidates: ["it"] }), { action: "stop", reason: "all_onboarded" });
    // Malformed external_locales: fail closed.
    assert.deepStrictEqual(lib.nextLanguage({ ...done, policy: { ...ext, external_locales: "vi" } }), { action: "stop", reason: "no_onboarding_policy" });
});

// A conflicting onboarding PR (#494: generated before the external vi oracle changed the shared golden
// indexes) is regenerated when it's still pure generator output; anything else is a person's to resolve.
const BOT = "sabbasi3-factory-controller[bot]";
const SHA = "0888a104".padEnd(40, "0");
const genPr = (over = {}) => ({
    number: 494,
    code: "zh-hans",
    head_sha: SHA,
    author: BOT,
    mergeable_state: "dirty",
    commits: [{ sha: SHA, author_login: BOT, committer_login: BOT, message: "onboard: zh-hans (generated)", parents: 1 }],
    files: ["src/locales/zh_hans/locale.json", "src/locales/zh_hans/parsers/.gitkeep", "tests/golden/zh_hans/casual.json", "tests/golden/index.json", "tests/golden/configurations.json", "harness/golden/coverage/zh_hans.json", "scripts/seed-backlog/taskmap.d/zh_hans.yaml", "contracts/zh-hans/zh-hans-casual-date-parser.yaml"],
    ...over,
});

test("onboarding PR conflicting with main: regenerated when pure generator output (same PR), else stop", () => {
    const base = { ...fiDone(), candidates: ["id", "zh-hans"], openPRs: ["zh-hans"] };
    assert.deepStrictEqual(lib.nextLanguage({ ...base, onboardPRs: [genPr()] }), { action: "regenerate", code: "zh-hans", pr: 494, head: SHA, reason: "dirty" });
    // Not conflicting (clean, blocked on checks, or GitHub hasn't computed it yet): wait as before.
    for (const state of ["clean", "blocked", "unknown", "behind", undefined]) {
        assert.deepStrictEqual(lib.nextLanguage({ ...base, onboardPRs: [genPr({ mergeable_state: state })] }), { action: "wait", reason: "onboarding_pr_open:zh-hans" }, String(state));
    }
    // The details unreadable or absent (no --onboard-prs): never regenerated, wait.
    for (const onboardPRs of [null, undefined, []]) assert.strictEqual(lib.nextLanguage({ ...base, onboardPRs }).reason, "onboarding_pr_open:zh-hans");
    // Hand work on the PR: a person resolves the conflict (stop raises one alert).
    const commit = genPr().commits[0];
    const handEdited = [
        { commits: [commit, { ...commit, sha: "f".repeat(40), author_login: "sabbasi3", committer_login: "sabbasi3", message: "fix conflict" }], head_sha: "f".repeat(40) },
        { commits: [{ ...commit, author_login: "sabbasi3" }] },
        { commits: [{ ...commit, committer_login: "web-flow" }] },
        { commits: [{ ...commit, message: "onboard: zh-hans (generated) + tweak" }] },
        { commits: [{ ...commit, parents: 2 }] },
        { commits: [{ ...commit, sha: "e".repeat(40) }] },
        { files: [...genPr().files, "src/locales/mod.rs"] },
        { files: [...genPr().files, "src/locales/zh_hans/parsers/casual.rs"] },
        { files: ["contracts/zh-hant/x.yaml"] },
        { files: [] },
        { author: "sabbasi3" },
        { head_sha: "not-a-sha" },
    ];
    for (const over of handEdited) {
        const pr = genPr(over);
        assert.strictEqual(lib.pureGeneratorPr(pr), false, JSON.stringify(over));
        assert.deepStrictEqual(lib.nextLanguage({ ...base, onboardPRs: [pr] }), { action: "stop", reason: "onboarding_pr_conflict:zh-hans" }, JSON.stringify(over));
    }
    assert.strictEqual(lib.pureGeneratorPr(genPr()), true);
    // An external locale's PR is never regenerated, even pure and conflicting: it just waits.
    const ext = { ...base, policy: { ...base.policy, external_locales: ["zh-hans"] }, onboardPRs: [genPr()] };
    assert.deepStrictEqual(lib.nextLanguage(ext), { action: "wait", reason: "onboarding_pr_open:zh-hans" });
});

test("onboard.yml regenerates in place: same branch and PR (counted once), with a lease, never a second PR", () => {
    const fs = require("fs");
    const path = require("path");
    const YAML = require("yaml");
    const wf = YAML.parse(fs.readFileSync(path.join(__dirname, "../../../.github/workflows/onboard.yml"), "utf8"));
    assert.match(wf.jobs.generate.if, /action == 'regenerate'/);
    const decision = wf.jobs.decide.steps.find((s) => s.id === "decision").run;
    assert.match(decision, /--onboard-prs "\$d\/onboard-prs\.json"/);
    // A PR whose detail can't be read is skipped with a warning, never failing the Inputs step.
    const inputs = wf.jobs.decide.steps.find((s) => s.name === "Inputs (read-only)").run;
    assert.match(inputs, /if ! rec=\$\(detail "\$n"\); then echo "::warning::[^"]*"; continue; fi/);
    for (const call of inputs.slice(inputs.indexOf("detail() {"), inputs.indexOf("\n}\n")).split("\n").filter((l) => /gh api|jq -nc/.test(l))) {
        if (!/\|\| return 1/.test(call) && !/\\$/.test(call)) assert.fail(`unguarded: ${call}`);
    }
    assert.deepStrictEqual(Object.keys(wf.jobs.decide.outputs).sort(), ["action", "code", "head", "pr", "reason"]);
    const apply = wf.jobs.apply.steps.find((s) => s.name === "Open the onboarding PR").run;
    const regen = apply.slice(apply.indexOf('if [ "$ACTION" = "regenerate" ]'), apply.indexOf('git push origin "$branch"'));
    assert.match(regen, /git push --force-with-lease="refs\/heads\/\$\{branch\}:\$\{PR_HEAD\}" origin "\$branch"/);
    assert.match(regen, /"OPEN \$branch \$PR_HEAD"/);
    assert.match(regen, /gh pr edit "\$PR"/);
    assert.match(regen, /exit 0\n\s*fi\n$/);
    assert.doesNotMatch(regen, /gh pr create/);
    assert.ok(apply.indexOf("gh pr create") > apply.indexOf('git push origin "$branch"'));
});
