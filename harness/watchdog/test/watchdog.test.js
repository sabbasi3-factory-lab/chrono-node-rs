"use strict";
const test = require("node:test");
const assert = require("node:assert");
const W = require("../watchdog");

const NOW = Date.parse("2026-11-08T12:00:00Z");
const hoursAgo = (h) => new Date(NOW - h * 3600_000).toISOString();
const minsAgo = (m) => new Date(NOW - m * 60_000).toISOString();

test("needs-human: only items labelled more than 6 h ago, keyed by their label event", () => {
    const items = [
        { number: 457, title: "ar/abstract-parser: Port", is_pr: false, labeled_at: hoursAgo(40), label_event_id: 9 },
        { number: 473, title: "[factory] ar/abstract-parser", is_pr: true, labeled_at: hoursAgo(6.5), label_event_id: 11 },
        { number: 500, title: "fresh", is_pr: false, labeled_at: hoursAgo(5.9), label_event_id: 12 },
        { number: 501, title: "unknown", is_pr: false, labeled_at: null, label_event_id: 0 },
    ];
    const f = W.staleNeedsHuman(items, NOW);
    assert.deepStrictEqual(f.map((x) => x.key), ["needs-human:457@9", "needs-human:473@11"]);
    assert.match(f[0].line, /issue #457 .*40 h/);
    assert.match(f[1].line, /^- PR #473 /);
});

test("slow CI: a checks job over 60 min, running or finished; other jobs and fast ones ignored", () => {
    const job = (run_id, over) => ({ run_id, name: "checks", status: "completed", started_at: minsAgo(100), completed_at: minsAgo(5), html_url: `u/${run_id}`, head_branch: "b", event: "pull_request", ...over });
    const jobs = [
        job(1, {}), // took 95 min
        job(2, { status: "in_progress", started_at: minsAgo(61), completed_at: null }), // running 61 min
        job(3, { started_at: minsAgo(50), completed_at: minsAgo(1) }), // 49 min
        job(4, { name: "Analyze (rust)" }),
        job(5, { started_at: null }),
    ];
    const f = W.slowChecks(jobs, NOW);
    assert.deepStrictEqual(f.map((x) => x.key), ["ci-run:1", "ci-run:2"]);
    assert.match(f[0].line, /took 95 min/);
    assert.match(f[1].line, /running for 61 min/);
});

test("each finding is raised once: anything listed in an earlier alert (open or closed) is skipped", () => {
    const f = [{ key: "needs-human:457@9", line: "a" }, { key: "needs-human:457@20", line: "b" }, { key: "ci-run:1", line: "c" }];
    const old = W.renderAlert("needs_human_stale", [f[0]], null).body;
    // Same issue relabelled later (new event id): a new finding.
    assert.deepStrictEqual(W.unraised(f, [old, null]).map((x) => x.key), ["needs-human:457@20", "ci-run:1"]);
    assert.deepStrictEqual(W.unraised(f, [W.renderAlert("ci_slow", f, null).body]), []);
});

test("alerts: the watchdog's own titles, never the controller's spend-alert titles; marker first", () => {
    for (const kind of Object.keys(W.TITLES)) {
        const a = W.renderAlert(kind, [{ key: "ci-run:7", line: "- x" }], "https://run");
        assert.strictEqual(a.title, W.TITLES[kind]);
        assert.ok(a.body.startsWith(W.MARKER));
        assert.deepStrictEqual(a.labels, ["factory:alert"]);
        assert.match(a.body, /<!-- watchdog-item: ci-run:7 -->/);
        // The controller treats an open alert with a "(spend bound off)" title as turning the bound off.
        assert.doesNotMatch(a.title, /spend bound off/);
    }
});
