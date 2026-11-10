"use strict";
const test = require("node:test");
const assert = require("node:assert");
const r = require("../router");

const CONFIG = { languages: ["it"], budget_aic: 2800, caps: { port: 500, repair: 300, threat_detection: 400, evals: 500 }, max_repairs: 2 };
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

test("run usage: every job that made model calls needs a complete file; missing records fail closed", () => {
    const line = (v, total) => JSON.stringify({ ai_credits_this_response: v, ...(total === undefined ? {} : { ai_credits_total: total }) });
    const files = { agent: `${line(199.5, 199.5)}\n${line(0.5, 200)}\n`, detection: `${line(12)}\n` };
    assert.strictEqual(r.runUsage(files, ["agent", "detection"]), 212);
    assert.strictEqual(r.runUsage(files, ["agent", "detection", "evals"]), null, "evals ran but recorded nothing");
    assert.strictEqual(r.runUsage({ ...files, evals: "" }, ["agent", "detection", "evals"]), null, "an empty file is incomplete");
    assert.throws(() => r.runUsage({ agent: line(50, 900) }, ["agent"]), /records are missing/);
    assert.throws(() => r.runUsage({ agent: line(-1) }, ["agent"]), /malformed/);
    // gh-aw v1.2's evals job (Decisions API): one record with `ai_credits`, absent without pricing.
    const evals = JSON.stringify({ provider: "copilot", model: "gpt-6.1-sol", input_tokens: 13449, output_tokens: 72, ai_credits: 1.25, timestamp: "2026-11-10T01:04:59Z" });
    assert.strictEqual(r.runUsage({ ...files, evals }, ["agent", "detection", "evals"]), 213.25);
    assert.strictEqual(r.runUsage({ ...files, evals: JSON.stringify({ input_tokens: 10, output_tokens: 2 }) }, ["agent", "detection", "evals"]), null, "unpriced: incomplete, never 0");
    assert.throws(() => r.runUsage({ evals: JSON.stringify({ ai_credits: -1 }) }, ["evals"]), /malformed/);
    assert.throws(() => r.runUsage({ evals: "[1]" }, ["evals"]), /malformed/);
});

test("spend: measured usage of every job; incomplete usage and runs in progress at caps", () => {
    const logs = {
        runs: [
            { run_id: 1, status: "completed", workflow_path: ".github/workflows/v2-port.lock.yml" },
            { run_id: 2, status: "completed", workflow_path: ".github/workflows/v2-repair.lock.yml" },
            { run_id: 3, status: "completed", workflow_path: ".github/workflows/v2-port.lock.yml" },
            { run_id: 4, status: "in_progress", workflow_path: ".github/workflows/v2-repair.lock.yml" },
            { run_id: 6, status: "completed", workflow_path: ".github/workflows/v2-repair.lock.yml" },
        ],
    };
    const u = (v) => JSON.stringify({ ai_credits_this_response: v });
    const files = { 1: { agent: u(200), detection: u(12) }, 2: { agent: u(40) }, 3: {}, 6: { agent: u(900) } };
    const inferred = { 1: ["agent", "detection"], 2: ["agent", "detection"], 3: [], 6: ["agent", "detection"] };
    const s = r.spendOf({ logs, filesOf: (x) => files[x.run_id], inferredOf: (x) => inferred[x.run_id], active: [{ id: 4, path: "x" }, { id: 5, path: ".github/workflows/v2-port.lock.yml" }], caps: CONFIG.caps });
    assert.deepStrictEqual(
        s.runs.map((x) => [x.run_id, x.aic, x.how]),
        [
            [1, 212, "measured"],
            [2, 700, "usage incomplete: at caps"],
            [3, 0, "measured"],
            [4, 700, "in progress: at caps"],
            [6, 900, "usage incomplete: at caps"],
            [5, 1400, "in progress: at caps"],
        ]
    );
    assert.strictEqual(s.spent, 3912);
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
    // Every AI job of the run is reserved at its cap: agent 500 + threat detection 400 + evals 500.
    assert.match(why({ spent: 1401 }), /budget: 1401 AIC spent \+ 1400 reserved/);
    assert.deepStrictEqual(start({ spent: 1400 }), { ok: true });
});

test("repair: at most max_repairs, never the same failure twice, within budget", () => {
    assert.deepStrictEqual(decide(), { action: "repair", reason: "ci failed (step:clippy)", attempt: 2 });
    assert.strictEqual(decide({ past: [{ event: "repair", signature: "step:golden" }] }).attempt, 3);
    assert.match(decide({ past: [{ event: "repair", signature: "step:clippy" }] }).reason, /same signature/);
    const two = [{ event: "repair", signature: "a" }, { event: "repair", signature: "b" }];
    assert.deepStrictEqual([decide({ past: two }).action, /after 2 repairs/.test(decide({ past: two }).reason)], ["needs_human", true]);
    // A repair reserves its agent 300 + threat detection 400.
    assert.match(decide({ spent: 2101 }).reason, /budget: 2101 AIC spent \+ 700 reserved/);
    assert.strictEqual(decide({ spent: 2100 }).action, "repair");
});

test("repair: gates first, merge queue, stale heads, green runs, labels and the kill switch", () => {
    assert.strictEqual(decide({ gates: "failure" }).action, "needs_human");
    assert.strictEqual(decide({ gates: "failure", conclusion: "success" }).action, "needs_human");
    assert.strictEqual(decide({ gates: "failure", conclusion: null }).action, "needs_human", "gates fails while ci still runs");
    assert.strictEqual(decide({ gates: "cancelled" }).action, "needs_human");
    assert.deepStrictEqual(decide({ gates: null }), { action: "none", reason: "ci failed; waiting for gates on this head" });
    assert.strictEqual(decide({ conclusion: null }).action, "none");
    assert.deepStrictEqual(decide({ conclusion: "success" }).action, "none");
    assert.strictEqual(decide({ event: "merge_group" }).action, "needs_human");
    assert.strictEqual(decide({ event: "merge_group", conclusion: "success" }).action, "none");
    assert.strictEqual(decide({ headIsCurrent: false }).action, "none");
    assert.strictEqual(decide({ labels: ["needs-human"] }).action, "none");
    assert.strictEqual(decide({ enabled: false }).action, "none");
    assert.strictEqual(decide({ conclusion: "cancelled" }).action, "none");
});

test("agent run completion: no PR from a port, or no push from a repair, goes to a person", () => {
    const d = (over) => r.agentRunDecision({ enabled: true, title: "Port it #12", conclusion: "failure", pr: null, marker: null, ...over });
    assert.deepStrictEqual(d(), { action: "needs_human", reason: "v2-port failure without opening a PR", issue: 12, unit: "it" });
    assert.strictEqual(d({ conclusion: "success", pr: { number: 30, head_sha: "h1" } }).action, "none");
    const m = { event: "repair", pr: 30, head: "h1", attempt: 2 };
    assert.strictEqual(d({ title: "Repair it #12 attempt 2", pr: { number: 30, head_sha: "h1" }, marker: m }).action, "needs_human");
    assert.strictEqual(d({ title: "Repair it #12 attempt 2", conclusion: "success", pr: { number: 30, head_sha: "h2" }, marker: m }).action, "none");
    assert.strictEqual(d({ title: "Repair it #12 attempt 2", pr: null, marker: m }).action, "none", "PR gone (merged or closed)");
    assert.strictEqual(d({ title: "Implement it/x #12 attempt 1" }).action, "none");
    assert.strictEqual(d({ enabled: false }).action, "none");
});
