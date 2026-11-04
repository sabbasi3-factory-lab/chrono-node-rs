"use strict";
const test = require("node:test");
const assert = require("node:assert");
const u = require("../upstream");

test("pinned, newer and areaOf", () => {
    assert.deepStrictEqual(u.pinned("| Version | `v2.10.3` |\n| Commit | `" + "a".repeat(40) + "` |"), { tag: "v2.10.3", commit: "a".repeat(40) });
    assert.throws(() => u.pinned("nothing"));
    assert.ok(u.newer("v2.10.10", "v2.10.9") && u.newer("v3.0.0", "v2.99.99") && !u.newer("v2.10.3", "v2.10.3"));
    assert.strictEqual(u.areaOf("test/en/en_weekday.test.ts"), "en/weekday");
    assert.strictEqual(u.areaOf("test/en/en.test.ts"), "en/general");
    assert.strictEqual(u.areaOf("test/system.test.ts"), "core/system");
});

test("summarize maps changed upstream files to tasks, new steps, configurations, core, tests and unported languages", () => {
    const taskmap = {
        done: [{ step: "ENWeekdayParser", rust: "src/locales/en/parsers/weekday.rs" }],
        tasks: [{ id: "en/month-name-parser", step: "ENMonthNameParser", source: "locales/en/parsers/ENMonthNameParser.ts" }],
    };
    const s = u.summarize(
        [
            { filename: "src/locales/en/parsers/ENMonthNameParser.ts", status: "modified" },
            { filename: "src/locales/en/parsers/ENWeekdayParser.ts", status: "modified" },
            { filename: "src/locales/en/parsers/ENNewParser.ts", status: "added" },
            { filename: "src/common/parsers/AbstractParserWithWordBoundary.ts", status: "modified" },
            { filename: "src/locales/en/refiners/ENGoneRefiner.ts", status: "removed" },
            { filename: "src/locales/en/configuration.ts", status: "modified" },
            { filename: "src/results.ts", status: "modified" },
            { filename: "test/en/en_month.test.ts", status: "modified" },
            { filename: "src/locales/zh/parsers/ZHHansDateParser.ts", status: "modified" },
            { filename: "package.json", status: "modified" },
        ],
        taskmap,
        ["en", "de"],
    );
    assert.deepStrictEqual(s.steps.map((x) => x.task), ["en/month-name-parser", null]);
    assert.deepStrictEqual(s.new_steps.map((x) => x.step), ["ENNewParser"]);
    assert.deepStrictEqual(s.removed_steps.map((x) => x.step), ["ENGoneRefiner"]);
    assert.deepStrictEqual(s.configuration, ["src/locales/en/configuration.ts"]);
    assert.deepStrictEqual(s.core, ["src/common/parsers/AbstractParserWithWordBoundary.ts", "src/results.ts"]);
    assert.deepStrictEqual(s.tests, [{ file: "test/en/en_month.test.ts", area: "en/month", status: "modified" }]);
    assert.deepStrictEqual(s.unported, ["src/locales/zh/parsers/ZHHansDateParser.ts"]);
    assert.deepStrictEqual(s.other, ["package.json"]);
});

test("summarize: a rename is a removal of the old path and an addition of the new one", () => {
    const taskmap = { done: [], tasks: [{ id: "en/month-name-parser", step: "ENMonthNameParser", source: "locales/en/parsers/ENMonthNameParser.ts" }] };
    const s = u.summarize(
        [
            { filename: "src/locales/en/parsers/ENMonthParser.ts", previous_filename: "src/locales/en/parsers/ENMonthNameParser.ts", status: "renamed" },
            { filename: "src/locales/zh/parsers/ENMonthNameParser.ts", previous_filename: "src/locales/en/parsers/ENMonthNameParser.ts", status: "renamed" },
        ],
        taskmap,
        ["en"],
    );
    assert.deepStrictEqual(s.removed_steps.map((x) => x.task), ["en/month-name-parser", "en/month-name-parser"]);
    assert.deepStrictEqual(s.new_steps.map((x) => x.step), ["ENMonthParser"]);
    assert.deepStrictEqual(s.unported, ["src/locales/zh/parsers/ENMonthNameParser.ts"]);
});
