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
        assert.ok(a.body.includes("<!-- watchdog-item: ci-run:7 -->"));
        // The controller treats an open alert with a "(spend bound off)" title as turning the bound off.
        assert.doesNotMatch(a.title, /spend bound off/);
    }
});

test("CI discovery: active runs of any age (re-runs keep created_at), finished ones only within the lookback", () => {
    const r = (id, over) => ({ id, status: "completed", created_at: hoursAgo(30), run_started_at: minsAgo(70), updated_at: minsAgo(5), ...over });
    const runs = [
        r(1, { status: "in_progress", updated_at: minsAgo(1) }), // re-run of an old run, attempt running 70 min
        r(2, {}), // re-run finished 5 min ago after 65 min
        r(3, { updated_at: hoursAgo(5), run_started_at: hoursAgo(7) }), // finished long ago
        r(4, { status: "in_progress", run_started_at: minsAgo(20) }), // running, short
        r(1, { status: "in_progress" }), // listed twice
    ];
    assert.deepStrictEqual(W.candidateRuns(runs, NOW).map((x) => x.id), [1, 2]);
});

test("raise input: a plan from the artifact is validated; titles can't forge item markers", () => {
    // Nested and alternative delimiters too ("<<!--!--", "--!>"): no "<" or ">" survives.
    const f = W.staleNeedsHuman([{ number: 9, title: "x <<!--!-- watchdog-item: ci-run:1 --!> -->> y", is_pr: false, labeled_at: hoursAgo(7), label_event_id: 3 }], NOW);
    assert.doesNotMatch(f[0].line, /[<>]/);
    assert.deepStrictEqual([...W.raisedKeys([W.renderAlert("needs_human_stale", f, null).body])], ["needs-human:9@3"]);
    const ok = { needs_human_stale: { findings: f, run_url: "https://github.com/o/r/actions/runs/5" } };
    assert.strictEqual(W.checkPlan(ok), ok);
    assert.throws(() => W.checkPlan({ other: ok.needs_human_stale }));
    assert.throws(() => W.checkPlan({ ci_slow: { findings: [{ key: "ci-run:x", line: "- a" }], run_url: null } }));
    for (const bad of ["a --> b", "a --!> b", "a < b"]) assert.throws(() => W.checkPlan({ ci_slow: { findings: [{ key: "ci-run:1", line: bad }], run_url: null } }));
    assert.throws(() => W.checkPlan({ ci_slow: { findings: [{ key: "ci-run:1", line: "a" }], run_url: "https://evil" } }));
});

test("green stall: a factory PR whose ci passed over 2 h ago, not queued, not needs-human (#477)", () => {
    const pr = (number, over) => ({ number, title: "[factory] ar/x", head_sha: "5e3a80b123c95d44aa", in_merge_queue: false, labels: [], ci: { conclusion: "success", completed_at: hoursAgo(2.5) }, gates: null, ...over });
    const f = W.greenStalled(
        [
            pr(477, {}), // gates never ran
            pr(478, { ci: { conclusion: "success", completed_at: hoursAgo(1) } }), // too recent
            pr(479, { in_merge_queue: true }),
            pr(480, { labels: ["needs-human"] }),
            pr(481, { ci: { conclusion: "failure", completed_at: hoursAgo(5) } }),
            pr(482, { ci: null }),
            pr(483, { gates: "success" }),
        ],
        NOW,
    );
    assert.deepStrictEqual(f.map((x) => x.key), ["pr-green:477@5e3a80b123c9", "pr-green:483@5e3a80b123c9"]);
    assert.match(f[0].line, /gates never ran/);
    assert.match(f[1].line, /gates success/);
});

test("no progress: a picked task with no non-passive event naming it, its issue or its PRs for over 6 h", () => {
    const ev = (type, h, payload) => ({ type, timestamp: hoursAgo(h), payload });
    const issue = (number, task, sinceH) => ({ number, title: `${task}: Port`, task, since: hoursAgo(sinceH) });
    const events = [
        ev("dispatched", 20, { task: "ar/a", issue: 457 }),
        ev("triage_dispatched", 1, { task: "ar/a", issue: 457, pr: 477 }), // advisory: not progress
        ev("run_spend", 1, { task: "ar/a" }), // measurement: not progress
        ev("check_result", 3, { prs: [490] }), // ar/b's PR
        ev("queued", 2, { pr: 491 }), // ar/c's PR
    ];
    const prsByTask = new Map([["ar/a", [477]], ["ar/b", [490]], ["ar/c", [491]]]);
    const f = W.noProgress([issue(457, "ar/a", 30), issue(458, "ar/b", 30), issue(459, "ar/c", 30), issue(460, "ar/d", 2), issue(461, "ar/e", 9)], events, prsByTask, NOW);
    assert.deepStrictEqual(f.map((x) => x.key.split("@")[0]), ["no-progress:457", "no-progress:461"]);
    // Keyed by the last progress time: the same stall is raised once; new progress then a new stall is new.
    assert.strictEqual(f[0].key, `no-progress:457@${Math.floor(Date.parse(hoursAgo(20)) / 1000)}`);
    assert.match(f[0].line, /last controller progress .* \(20 h ago\)/);
});

test("taskOf: the Factory-Task trailer; plans with the new keys validate", () => {
    assert.strictEqual(W.taskOf("## Summary\nx\n\nFactory-Task: ar/abstract-parser\nContract-SHA: abc1234"), "ar/abstract-parser");
    assert.strictEqual(W.taskOf("Factory-Task:"), null);
    assert.strictEqual(W.taskOf("Factory-Task: ar/my_parser"), "ar/my_parser"); // task ids may contain _ (controller tasks.ts)
    assert.strictEqual(W.taskOf(null), null);
    for (const [kind, key] of [["pr_green_stalled", "pr-green:477@5e3a80b123c9"], ["task_no_progress", "no-progress:457@1762600000"]]) {
        const p = { [kind]: { findings: [{ key, line: "- x" }], run_url: null } };
        assert.strictEqual(W.checkPlan(p), p);
        assert.deepStrictEqual([...W.raisedKeys([W.renderAlert(kind, p[kind].findings, null).body])], [key]);
    }
});

test("audit days: back to the earliest floor (a long stall keeps its key), at least yesterday, at most 30 days", () => {
    assert.deepStrictEqual(W.auditDays([], NOW), ["2026/11/07", "2026/11/08"]);
    assert.deepStrictEqual(W.auditDays([hoursAgo(80), hoursAgo(2)], NOW), ["2026/11/05", "2026/11/06", "2026/11/07", "2026/11/08"]);
    assert.strictEqual(W.auditDays([hoursAgo(24 * 90)], NOW).length, 30);
});

test("rate limit: only a run whose Findings step succeeded in the last 10 min counts; skipped runs don't", () => {
    const run = (id, conclusion, mins) => ({ id, jobs: [{ steps: [{ name: "Rate limit (workflow_run only)", conclusion: "success", completed_at: minsAgo(mins) }, { name: "Findings (read-only)", conclusion, completed_at: conclusion === "skipped" ? null : minsAgo(mins) }] }] });
    assert.strictEqual(W.recentlyEvaluated([run(1, "success", 5)], 9, NOW), true);
    // A chain of successful-but-skipped runs never suppresses an evaluation (the #483 review finding).
    assert.strictEqual(W.recentlyEvaluated([run(2, "skipped", 1), run(3, "skipped", 4), run(4, "skipped", 8)], 9, NOW), false);
    assert.strictEqual(W.recentlyEvaluated([run(5, "success", 11)], 9, NOW), false);
    assert.strictEqual(W.recentlyEvaluated([run(6, "failure", 2)], 9, NOW), false);
    assert.strictEqual(W.recentlyEvaluated([run(9, "success", 2)], 9, NOW), false, "itself doesn't count");
});

test("controller failing: 5+ failed runs in a row, one finding per streak (keyed by its first failure)", () => {
    const run = (id, conclusion, extra = {}) => ({ id, conclusion, created_at: hoursAgo(id / 100), ...extra });
    // Newest first: 4 failures, a cancelled run and a relevance-skipped success in between, then a real poll.
    const runs = [run(1, "failure"), run(2, "cancelled"), run(3, "failure"), run(4, "success", { polled: false }), run(5, "failure"), run(6, "failure"), run(7, "success"), run(8, "failure")];
    assert.deepStrictEqual(W.controllerFailStreak(runs), [], "4 in a row: not yet");
    const five = [run(0, "failure"), ...runs];
    const f = W.controllerFailStreak(five);
    assert.deepStrictEqual(f.map((x) => x.key), ["controller-fail:6"]);
    assert.match(f[0].line, /^- 5 controller runs failed in a row since .* \(newest .*, run 0\)$/);
    // The streak grows: same key, so the existing alert covers it (raised once).
    const longer = [run(-1, "failure"), ...five];
    assert.deepStrictEqual(W.controllerFailStreak(longer).map((x) => x.key), ["controller-fail:6"]);
    assert.deepStrictEqual(W.unraised(W.controllerFailStreak(longer), [W.renderAlert("controller_failing", f, null).body]), []);
    // A real poll (success that polled, or unknown) ends it; timed_out and startup_failure count.
    assert.deepStrictEqual(W.controllerFailStreak([run(1, "timed_out"), run(2, "startup_failure"), run(3, "failure"), run(4, "failure"), run(5, "failure"), run(6, "success")]).map((x) => x.key), ["controller-fail:5"]);
    assert.deepStrictEqual(W.controllerFailStreak([run(1, "failure"), run(2, "success", { polled: true }), run(3, "failure"), run(4, "failure"), run(5, "failure"), run(6, "failure")]), []);
    // The plan validates; its title is the watchdog's own.
    const p = { controller_failing: { findings: f, run_url: null } };
    assert.strictEqual(W.checkPlan(p), p);
    assert.match(W.TITLES.controller_failing, /^Factory watchdog: 5 or more controller runs failed in a row$/);
});
