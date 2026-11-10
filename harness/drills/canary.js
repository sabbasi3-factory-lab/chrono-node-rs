#!/usr/bin/env node
"use strict";
// Agentic workflow canary (.github/workflows/agentic-canary.yml). Plain code, no AI.
//
// Dispatches each AI workflow the controller dispatches (implement, repair, review, triage) for the
// sentinel task `drill/activation-canary`, which has no contract. gh-aw's activation job (lock file
// and frontmatter hash check, secrets, App token) must succeed; the workflow's own pre-inference
// validation step must then refuse the dispatch (no contract on main, or the kill switch when
// FACTORY_ENABLED is off), so the agent never runs. gh-aw's threat detection job still runs on the
// empty output (`if: always()` in v1.0.1): about 10 AIC per run (run 41662949515: 10.6), so about
// 40 AIC a day for the four, counted by the spend collector like any run. Anything else (activation
// failing, as on #393's review run 42171900921 with E009 CONFIG_HASH_MISMATCH) fails the canary,
// before a real task needs that workflow.
//
//   node drills/canary.js run --out FILE    (GH_TOKEN: actions write + read; GITHUB_REPOSITORY)
//
// Runs whose task starts with `drill/` are excluded from the first-try rates, the results page and the factory review.
const fs = require("fs");

const TASK = "drill/activation-canary";
const SHA = "0".repeat(40);
/** Each workflow: its file, the inputs its validation accepts up to the contract check, its validation step and run name. */
const WORKFLOWS = {
    implement: { file: "implement.lock.yml", inputs: { task: TASK, issue: "1", attempt: "1", contract_sha: SHA }, validate: "Validate dispatch and contract freshness", title: `Implement ${TASK} #1 attempt 1` },
    repair: {
        file: "repair.lock.yml",
        inputs: { task: TASK, issue: "1", pr: "1", attempt: "2", contract_sha: SHA, head_sha: SHA, failure_signature: "step:canary", run_id: "1" },
        validate: "Validate dispatch, PR, failed head and failed run",
        title: `Repair ${TASK} #1 attempt 2`,
    },
    review: { file: "review.lock.yml", inputs: { task: TASK, pr: "1", head_sha: SHA, contract_sha: SHA }, validate: "Validate dispatch, PR head and contract", title: `Review ${TASK} PR #1` },
    triage: { file: "triage.lock.yml", inputs: { task: TASK, issue: "1", pr: "0", reason: "canary", run_id: "0", failure_signature: "" }, validate: "Validate dispatch, issue, PR and run", title: `Triage ${TASK} #1` },
};

/**
 * Whether a finished canary run is healthy, from its jobs (Actions jobs API). Pure.
 * Healthy: activation succeeded, and the agent job stopped at the validation step before inference.
 */
function verdict(jobs, validateStep) {
    const job = (name) => (jobs || []).find((j) => j.name === name);
    const firstFailed = (j) => (j.steps || []).find((s) => s.conclusion === "failure");
    const activation = job("activation");
    if (!activation) return { ok: false, why: "no activation job" };
    if (activation.conclusion !== "success") return { ok: false, why: `activation ${activation.conclusion}${firstFailed(activation) ? ` at "${firstFailed(activation).name}"` : ""}` };
    const agent = job("agent");
    if (!agent) return { ok: false, why: "no agent job" };
    const failed = firstFailed(agent);
    if (!failed) return { ok: false, why: `agent job ${agent.conclusion} without a failed step (the validation didn't refuse the sentinel task)` };
    if (failed.name !== validateStep) return { ok: false, why: `agent job failed at "${failed.name}", before its validation step` };
    // Inference in any job: the agent's must never run; threat detection's is expected (reported).
    const ran = (jobs || []).flatMap((j) => (j.steps || []).filter((s) => /^Execute /.test(s.name) && s.conclusion !== "skipped" && s.conclusion !== null).map((s) => ({ job: j.name, step: s.name, conclusion: s.conclusion })));
    const unexpected = ran.filter((r) => r.job !== "detection");
    if (unexpected.length > 0) return { ok: false, why: `inference ran in ${unexpected.map((r) => `${r.job} ("${r.step}": ${r.conclusion})`).join(", ")}` };
    const detection = ran.some((r) => r.job === "detection");
    return { ok: true, why: `activation ok; refused at "${failed.name}"${detection ? "; threat detection ran (expected, ~10 AIC)" : ""}`, detection_inference: detection };
}

async function api(method, path, body) {
    const res = await fetch(`https://api.github.com${path}`, {
        method,
        headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status}`);
    return res.status === 204 ? null : res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function canary(repo, name, w, { timeoutMs = 25 * 60_000, pollMs = 20_000 } = {}) {
    const since = new Date(Date.now() - 5_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    await api("POST", `/repos/${repo}/actions/workflows/${w.file}/dispatches`, { ref: "main", inputs: w.inputs });
    const deadline = Date.now() + timeoutMs;
    let run = null;
    while (Date.now() < deadline) {
        await sleep(pollMs);
        const list = await api("GET", `/repos/${repo}/actions/workflows/${w.file}/runs?event=workflow_dispatch&created=%3E%3D${since}&per_page=20`);
        run = (list.workflow_runs || []).filter((r) => r.display_title === w.title).sort((a, b) => a.id - b.id)[0] || null;
        if (run && run.status === "completed") break;
    }
    if (!run) return { workflow: name, ok: false, why: "the dispatched run never appeared" };
    if (run.status !== "completed") return { workflow: name, run_id: run.id, ok: false, why: `not finished after ${timeoutMs / 60_000} min` };
    const jobs = (await api("GET", `/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`)).jobs || [];
    return { workflow: name, run_id: run.id, url: run.html_url, ...verdict(jobs, w.validate) };
}

async function main() {
    const [cmd] = process.argv.slice(2);
    const i = process.argv.indexOf("--out");
    const repo = process.env.GITHUB_REPOSITORY;
    if (cmd !== "run" || i < 0 || !repo) {
        console.error("usage: GITHUB_REPOSITORY=o/r GH_TOKEN=... canary.js run --out FILE");
        process.exit(2);
    }
    const results = await Promise.all(
        Object.entries(WORKFLOWS).map(([name, w]) => canary(repo, name, w).catch((e) => ({ workflow: name, ok: false, why: e.message }))),
    );
    for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.workflow}${r.run_id ? ` (run ${r.run_id})` : ""}: ${r.why}`);
    fs.writeFileSync(process.argv[i + 1], JSON.stringify({ at: new Date().toISOString(), results }, null, 2) + "\n");
    process.exitCode = results.every((r) => r.ok) ? 0 : 1;
}

if (require.main === module) main();

module.exports = { verdict, WORKFLOWS, TASK };
