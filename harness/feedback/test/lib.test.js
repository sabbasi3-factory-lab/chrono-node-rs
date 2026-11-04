"use strict";
const test = require("node:test");
const assert = require("node:assert");
const lib = require("../lib");

const req = (over = {}) => ({
    id: 3,
    text: "tonight at 9",
    config: "en.casual",
    reference: { kind: "date", instant: "2011-01-01T00:48:32.000Z", timezone_input: null },
    system_timezone: "UTC",
    options: {},
    ...over,
});
const mm = (over = {}, requires = { parsers: ["ENCasualDateParser"], refiners: [] }) => ({ request: req(over), requires, expected: [{ index: 0 }], actual: [] });

test("signature: same config and steps dedupe, whatever the phrase", () => {
    assert.strictEqual(lib.signature(mm({ text: "a" })), lib.signature(mm({ text: "b", id: 9 })));
    assert.notStrictEqual(lib.signature(mm()), lib.signature(mm({ config: "en.strict" })));
    assert.notStrictEqual(lib.signature(mm()), lib.signature(mm({}, { parsers: ["ENCasualDateParser"], refiners: ["X"] })));
    assert.match(lib.signature(mm()), /^[0-9a-f]{12}$/);
});

test("fixId: stable per request, ignores the run id, keyed by language", () => {
    assert.strictEqual(lib.fixId(req()), lib.fixId(req({ id: 77 })));
    assert.notStrictEqual(lib.fixId(req()), lib.fixId(req({ text: "tonight at 10" })));
    assert.match(lib.fixId(req()), /^en\/fix-[0-9a-f]{8}$/);
    assert.match(lib.fixId(req({ config: "de.strict" })), /^de\/fix-/);
});

test("groupMismatches: one group per signature, the shortest text as the repro", () => {
    const groups = lib.groupMismatches([mm({ id: 1, text: "tonight at nine pm" }), mm({ id: 2, text: "tonight" }), mm({ id: 3, config: "en.strict" })]);
    assert.strictEqual(groups.length, 2);
    assert.strictEqual(groups[0].count, 2);
    assert.strictEqual(groups[0].repro.request.text, "tonight");
});

test("the monitor's issue parses back into the same request (one parser for the form and the monitor)", () => {
    for (const r of [req(), req({ reference: { kind: "object", instant: "2020-02-29T23:00:00.000Z", timezone_input: "EST" }, options: { forwardDate: true } }), req({ reference: { kind: "object", instant: "2020-02-29T23:00:00.000Z", timezone_input: -300 }, text: "line one\n thanks 😀" })]) {
        const g = lib.groupMismatches([{ request: r, requires: { parsers: ["P"], refiners: [] }, expected: [], actual: [{}] }])[0];
        const { body } = lib.renderMonitorIssue(g, { seed: 5, phrases: 10, date: "2026-11-04" });
        const parsed = lib.parseReport(body);
        assert.deepStrictEqual(parsed.request, { id: 0, ...lib.canonicalRequest(r), system_timezone: "UTC" });
        assert.match(body, new RegExp(lib.MONITOR_MARKER(g.signature)));
    }
});

test("parseReport: the issue form's output", () => {
    const body = "### Configuration\n\nfr.strict\n\n### Text\n\n```text\nlundi prochain\n```\n\n### Reference date\n\n2024-02-29T12:00:00Z\n\n### Reference timezone\n\n_No response_\n\n### Options\n\n_No response_\n";
    assert.deepStrictEqual(lib.parseReport(body).request, {
        id: 0,
        text: "lundi prochain",
        config: "fr.strict",
        reference: { kind: "date", instant: "2024-02-29T12:00:00.000Z", timezone_input: null },
        options: {},
        system_timezone: "UTC",
    });
});

test("parseReport: rejects anything unexpected (issue text is data)", () => {
    const base = "### Configuration\n\nen.casual\n\n### Text\n\n```text\nnow\n```\n\n### Reference date\n\n2024-02-29T12:00:00Z\n";
    assert.ok(lib.parseReport(base).request);
    assert.match(lib.parseReport(base.replace("en.casual", "en.casual; rm -rf /")).error, /Configuration/);
    assert.match(lib.parseReport(base.replace("2024-02-29T12:00:00Z", "tomorrow")).error, /Reference date/);
    assert.match(lib.parseReport(base + "\n### Options\n\n```json\n{\"debug\":true}\n```\n").error, /Options/);
    assert.match(lib.parseReport(base + "\n### Reference timezone\n\n$(id)\n").error, /timezone/);
    assert.match(lib.parseReport(base.replace("now", "a\n```\n```text\nb")).error, /Text/);
    assert.match(lib.parseReport(base.replace("```text\nnow\n```", "x".repeat(1001))).error, /Text/);
    assert.match(lib.parseReport(null).error, /missing/);
});

test("updateLastSeen: only the monitor's own issues have the line", () => {
    const g = lib.groupMismatches([mm()])[0];
    const { body } = lib.renderMonitorIssue(g, { seed: 1, phrases: 10, date: "2026-11-01" });
    const updated = lib.updateLastSeen(body, { date: "2026-11-04", seed: 9, count: 4, runUrl: "u" });
    assert.match(updated, /- Last seen: 2026-11-04 · 4 phrase\(s\) · seed `9` · u/);
    assert.doesNotMatch(updated, /2026-11-01/);
    assert.strictEqual(lib.updateLastSeen("<!-- factory-task: en/fix-1 -->", { date: "x" }), null);
});

test("decide and the fixed comments", () => {
    assert.deepStrictEqual(lib.decide({ status: "mismatched" }), { action: "propose", reason: "mismatch" });
    assert.strictEqual(lib.decide({ status: "matched" }).reason, "same_as_chrono_node");
    assert.strictEqual(lib.decide({ status: "not_comparable" }).reason, "not_yet_ported");
    assert.strictEqual(lib.decide(undefined).reason, "error");
    assert.match(lib.reportComment("not_yet_ported", { missing: ["ENFooParser", "<script>"] }), /`ENFooParser`\. They/);
    assert.match(lib.reportComment("proposed", { fix: "en/fix-1", pr: 5 }), /#5/);
});
