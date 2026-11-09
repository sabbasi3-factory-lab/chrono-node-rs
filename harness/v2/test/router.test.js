"use strict";
const test = require("node:test");
const assert = require("node:assert");
const r = require("../router");

const CONFIG = { languages: ["it"], budget_aic: 1000, caps: { port: 500, repair: 300, threat_detection: 400 }, max_repairs: 2 };
const CONTRACTS = { it: { sha: "a".repeat(40), tiers: ["auto", "auto"] } };
const start = (over = {}) => r.startDecision({ enabled: true, unit: "it", config: CONFIG, external: ["vi", "it"], contracts: CONTRACTS, issue: null, openPr: null, spent: 0, ...over });
const decide = (over = {}) =>
    r.repairDecision({ enabled: true, event: "pull_request", conclusion: "failure", headIsCurrent: true, gates: "success", signature: "step:clippy", past: [], labels: [], config: CONFIG, spent: 300, ...over });

test("trailers and the closing issue (the dispatch's footer, the last Closes line, wins)", () => {
    const body = "Closes #1\n\nsummary\n\nCloses #42\n\nFactory-Unit: it\nContract-SHA: abc1234\n";
    assert.strictEqual(r.trailer(body, "Factory-Unit"), "it");
    assert.strictEqual(r.closesIssue(body), 42);
    assert.strictEqual(r.closesIssue("closes #3"), null);
});

test("history reads only the router's own markers", () => {
    const c = [
        { user: { login: "github-actions[bot]" }, body: `text\n\n${r.marker({ event: "repair", pr: 7, signature: "step:x" })}` },
        { user: { login: "someone" }, body: r.marker({ event: "repair", pr: 7, signature: "step:y" }) },
        { user: { login: "github-actions[bot]" }, body: "<!-- factory-v2 {not json} -->" },
    ];
    assert.deepStrictEqual(r.history(c), [{ event: "repair", pr: 7, signature: "step:x" }]);
    assert.strictEqual(r.unitOfIssue({ body: `x ${r.issueMarker("zh-hant")}` }), "zh-hant");
});

test("failure signature: first failed step, else the job conclusion", () => {
    const job = { conclusion: "failure", steps: [{ name: "Checkout", conclusion: "success" }, { name: "cargo clippy -D warnings", conclusion: "failure" }, { name: "x", conclusion: "failure" }] };
    assert.strictEqual(r.failureSignature(job), "step:cargo-clippy-d-warnings");
    assert.strictEqual(r.failureSignature({ conclusion: "timed_out", steps: [] }), "job:timed_out");
    assert.strictEqual(r.failureSignature(undefined), "job:missing");
});

test("spend: measured usage of every job; missing usage and runs in progress at caps", () => {
    const logs = {
        runs: [
            { run_id: 1, status: "completed", workflow_path: ".github/workflows/v2-port.lock.yml", aic: 200 },
            { run_id: 2, status: "completed", workflow_path: ".github/workflows/v2-repair.lock.yml", aic: 50 },
            { run_id: 3, status: "completed", workflow_path: ".github/workflows/v2-port.lock.yml", aic: 0, token_usage: 0, turns: 0 },
            { run_id: 4, status: "in_progress", workflow_path: ".github/workflows/v2-repair.lock.yml" },
        ],
    };
    const usage = { 1: r.usageTotal(['{"ai_credits_this_response": 199.5}\n{"ai_credits_this_response": 0.5}\n', '{"ai_credits_this_response": 12}\n']), 2: null, 3: null };
    const s = r.spendOf({ logs, usageOf: (x) => usage[x.run_id], active: [{ id: 4, path: "x" }, { id: 5, path: ".github/workflows/v2-port.lock.yml" }], caps: CONFIG.caps });
    assert.deepStrictEqual(
        s.runs.map((x) => [x.run_id, x.aic]),
        [[1, 212], [2, 700], [3, 0], [4, 700], [5, 900]]
    );
    assert.strictEqual(s.spent, 2512);
    assert.throws(() => r.usageTotal(['{"ai_credits_this_response": -1}']), /malformed/);
    assert.strictEqual(r.usageTotal([]), null);
});

test("start: every guard fails closed with its reason", () => {
    assert.deepStrictEqual(start(), { ok: true });
    const why = (over) => start(over).reason;
    assert.match(why({ enabled: false }), /kill switch/);
    assert.match(why({ unit: "nl" }), /not in .github\/factory\/v2.yaml/);
    assert.match(why({ external: ["vi"] }), /external_locales, so v1 could work on it/);
    assert.match(why({ contracts: {} }), /no contracts\/it\//);
    assert.match(why({ contracts: { it: { sha: "a", tiers: ["auto", "auto-strict"] } } }), /auto-strict stays on v1/);
    assert.match(why({ issue: { number: 9, state: "closed" } }), /closed/);
    assert.match(why({ openPr: 12 }), /PR #12 is already open/);
    assert.match(why({ spent: 501 }), /budget: 501 AIC spent \+ 500/);
    assert.deepStrictEqual(start({ spent: 500 }), { ok: true });
});

test("repair: at most max_repairs, never the same failure twice, within budget", () => {
    assert.deepStrictEqual(decide(), { action: "repair", reason: "ci failed (step:clippy)", attempt: 2 });
    assert.strictEqual(decide({ past: [{ event: "repair", signature: "step:golden" }] }).attempt, 3);
    assert.match(decide({ past: [{ event: "repair", signature: "step:clippy" }] }).reason, /same signature/);
    const two = [{ event: "repair", signature: "a" }, { event: "repair", signature: "b" }];
    assert.deepStrictEqual([decide({ past: two }).action, /after 2 repairs/.test(decide({ past: two }).reason)], ["needs_human", true]);
    assert.match(decide({ spent: 701 }).reason, /budget/);
    assert.strictEqual(decide({ spent: 700 }).action, "repair");
});

test("repair: gates, merge queue, stale heads, green runs, labels and the kill switch", () => {
    assert.strictEqual(decide({ gates: "failure" }).action, "needs_human");
    assert.strictEqual(decide({ gates: "failure", conclusion: "success" }).action, "needs_human");
    assert.deepStrictEqual(decide({ conclusion: "success" }).action, "none");
    assert.strictEqual(decide({ event: "merge_group" }).action, "needs_human");
    assert.strictEqual(decide({ event: "merge_group", conclusion: "success" }).action, "none");
    assert.strictEqual(decide({ headIsCurrent: false }).action, "none");
    assert.strictEqual(decide({ labels: ["needs-human"] }).action, "none");
    assert.strictEqual(decide({ enabled: false }).action, "none");
    assert.strictEqual(decide({ conclusion: "cancelled" }).action, "none");
});
