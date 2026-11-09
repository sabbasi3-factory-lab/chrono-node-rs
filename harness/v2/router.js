#!/usr/bin/env node
"use strict";
// Factory v2 router (docs/factory-v2.md). Plain code, no AI, no dependencies; run by
// .github/workflows/v2-router.yml on events only (no schedule). It decides and records; GitHub does
// the rest (auto-merge, merge queue).
//
//   node v2/router.js spend LOGS.json  the spend of all v2 runs (gh aw logs output + runs in progress),
//                                      printed as JSON for V2_SPEND.
//   node v2/router.js start            push to main (contracts), workflow_dispatch, or an issue labelled
//                                      factory-v2:ready by a person: open the language's issue if needed,
//                                      check the kill switch, tiers, budget and that v1 leaves the
//                                      language alone, then dispatch v2-port.
//   node v2/router.js repair           ci or gates completed on a factory-v2 PR (or ci on its merge
//                                      group): once gates passed, dispatch v2-repair for a ci failure, or
//                                      hand the PR to a person (needs-human) when gates failed, the queue
//                                      failed, repairs are used up, the same failure repeats, or the
//                                      budget is spent.
//   node v2/router.js completed        a v2-port or v2-repair run completed: hand off if it opened no PR
//                                      or pushed no fix.
//
// Env: GH_TOKEN (the workflow's GITHUB_TOKEN), GITHUB_REPOSITORY, GITHUB_EVENT_NAME, GITHUB_EVENT_PATH,
// FACTORY_ENABLED, V2_CONFIG (.github/factory/v2.yaml as JSON), V2_EXTERNAL (external_locales of the
// pinned factory onboarding.yaml, JSON), V2_SPEND (the `spend` output), V2_CONTRACTS (JSON
// {<lang>: {sha, tiers}} for the v2 languages with contracts on main).
// Each decision is a comment on the language's issue with a machine-readable marker, so the next
// event reads the history from GitHub itself: the router keeps no state of its own.

const fs = require("fs");
const path = require("path");

const AGENT_LOGIN = "sabbasi3-factory-agent[bot]";
const ROUTER_LOGIN = "github-actions[bot]";
const BRANCH_PREFIX = "factory-v2/";
const LABEL = "factory-v2";
const LABEL_READY = "factory-v2:ready";
const LABEL_NEEDS_HUMAN = "needs-human";
const UNIT_ID = /^[a-z]{2}(?:-[a-z]+)?$/;
const MARK = /<!-- factory-v2 (\{[^\n]*?\}) -->/g;
const WORKFLOWS = { port: "v2-port.lock.yml", repair: "v2-repair.lock.yml" };

// ------------------------------------------------------------------ pure logic (tested)

/** `Key: value` trailer lines in a PR body (first occurrence wins, as in harness/gates/scope.js). */
function trailer(body, key) {
    const m = new RegExp(`^${key}:[ \\t]*(\\S+)[ \\t]*$`, "m").exec(body || "");
    return m ? m[1] : null;
}

/** The issue a v2 PR closes: the LAST `Closes #N` line (the dispatch's body-footer comes last). */
function closesIssue(body) {
    const all = [...String(body || "").matchAll(/^Closes #([1-9][0-9]{0,8})[ \t]*$/gm)];
    return all.length ? Number(all[all.length - 1][1]) : null;
}

const issueMarker = (unit) => `<!-- factory-v2-unit: ${unit} -->`;
const marker = (o) => `<!-- factory-v2 ${JSON.stringify(o)} -->`;
const unitOfIssue = (issue) => {
    const m = /<!-- factory-v2-unit: ([a-z]{2}(?:-[a-z]+)?) -->/.exec((issue && issue.body) || "");
    return m ? m[1] : null;
};

/** The router's own decision markers on an issue, oldest first (anyone else's comments are ignored). */
function history(comments) {
    const out = [];
    for (const c of comments || []) {
        if (!c || !c.user || c.user.login !== ROUTER_LOGIN) continue;
        for (const m of String(c.body || "").matchAll(MARK)) {
            try {
                out.push(JSON.parse(m[1]));
            } catch {
                // not a marker
            }
        }
    }
    return out;
}

/** Trusted failure signature from the runner's step results: `step:<slug>` of the first failed step, else `job:<conclusion>`. */
function failureSignature(job) {
    if (!job) return "job:missing";
    const step = (job.steps || []).find((s) => s.conclusion === "failure");
    if (!step) return `job:${job.conclusion || "unknown"}`;
    const slug = String(step.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 100);
    return `step:${slug || "unnamed"}`;
}

/**
 * AIC of one completed run from its usage files ({job: token_usage.jsonl text}), given the jobs that
 * made model calls (`inferred`, from the Actions jobs API). Every inferred job needs a non-empty file,
 * else the run's usage is incomplete: returns null (the caller counts the run at its caps). A
 * malformed record, or a cumulative `ai_credits_total` above the responses' sum (records missing),
 * throws: unknown spend fails closed.
 */
function runUsage(files, inferred) {
    let aic = 0;
    let complete = true;
    for (const job of new Set([...inferred, ...Object.keys(files)])) {
        const text = files[job];
        if (text === undefined) {
            complete = false;
            continue;
        }
        let sum = 0;
        let total = 0;
        let records = 0;
        for (const line of text.split("\n")) {
            if (!line.trim()) continue;
            const rec = JSON.parse(line);
            const v = rec.ai_credits_this_response;
            if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`${job}: malformed token_usage.jsonl record`);
            if (rec.ai_credits_total !== undefined) {
                if (typeof rec.ai_credits_total !== "number" || !Number.isFinite(rec.ai_credits_total)) throw new Error(`${job}: invalid ai_credits_total`);
                total = Math.max(total, rec.ai_credits_total);
            }
            sum += v;
            records++;
        }
        if (total > sum + Math.max(0.001, sum * 1e-6)) throw new Error(`${job}: ai_credits_total ${total} exceeds its responses' ${sum}: records are missing`);
        if (records === 0 && inferred.includes(job)) complete = false;
        aic += sum;
    }
    return complete ? aic : null;
}

/** Every AI job of one run at its cap: the agent, threat detection, and (v2-port only) evals. */
const reserveFor = (kind, caps) => (kind === "repair" ? caps.repair : caps.port + caps.evals) + caps.threat_detection;

/**
 * Spend of all v2 runs: a completed run counts every job's recorded usage (agent, threat detection,
 * evals); one whose usage is incomplete counts at its caps (reserveFor, or what it recorded if more),
 * as does a run in progress.
 *   logs: `gh aw logs --json` output; filesOf(run) => {job: text}; inferredOf(run) => [job] (jobs that
 *   made model calls); active: [{id, path}] queued or in progress; caps: v2.yaml caps.
 *   Returns {spent, runs: [{run_id, aic, how}]}.
 */
function spendOf({ logs, filesOf, inferredOf, active, caps }) {
    const bound = (p) => reserveFor(/v2-repair/.test(p || "") ? "repair" : "port", caps);
    const runs = [];
    const seen = new Set();
    for (const r of (logs && logs.runs) || []) {
        seen.add(Number(r.run_id));
        if (r.status !== "completed") {
            runs.push({ run_id: r.run_id, aic: bound(r.workflow_path), how: "in progress: at caps" });
            continue;
        }
        const files = filesOf(r);
        const used = runUsage(files, inferredOf(r));
        if (used === null) {
            const partial = runUsage(files, []);
            runs.push({ run_id: r.run_id, aic: Math.max(bound(r.workflow_path), partial), how: "usage incomplete: at caps" });
        } else runs.push({ run_id: r.run_id, aic: used, how: "measured" });
    }
    for (const a of active || []) {
        if (!seen.has(Number(a.id))) runs.push({ run_id: a.id, aic: bound(a.path), how: "in progress: at caps" });
    }
    return { spent: Math.round(runs.reduce((s, r) => s + r.aic, 0) * 100) / 100, runs };
}

/** Whether a language may start now. @returns {{ok: true} | {ok: false, reason: string}} */
function startDecision({ enabled, unit, config, external, contracts, issue, openPr, spent }) {
    if (!enabled) return { ok: false, reason: 'kill switch: FACTORY_ENABLED is not "true"' };
    if (!UNIT_ID.test(unit || "")) return { ok: false, reason: "invalid language code" };
    if (!(config.languages || []).includes(unit)) return { ok: false, reason: `${unit} is not in .github/factory/v2.yaml languages` };
    if (!(external || []).includes(unit)) return { ok: false, reason: `${unit} is not in the pinned factory onboarding.yaml external_locales, so v1 could work on it` };
    const c = contracts && contracts[unit];
    if (!c) return { ok: false, reason: `no contracts/${unit}/ on main yet` };
    if (!Array.isArray(c.tiers) || c.tiers.length === 0 || !c.tiers.every((t) => t === "auto")) {
        return { ok: false, reason: `contracts/${unit}/ has non-auto tiers (${[...new Set(c.tiers || [])].join(", ")}): auto-strict stays on v1` };
    }
    if (issue && issue.state !== "open") return { ok: false, reason: `issue #${issue.number} is closed` };
    if (openPr) return { ok: false, reason: `PR #${openPr} is already open for ${unit}` };
    const need = reserveFor("port", config.caps);
    if (spent + need > config.budget_aic) return { ok: false, reason: `budget: ${spent} AIC spent + ${need} reserved for the run > ${config.budget_aic}` };
    return { ok: true };
}

/**
 * What to do when `ci` or `gates` completes on a v2 PR head (or ci on its merge group). `conclusion` is
 * the newest ci run's on the head (null if not finished), `gates` the newest gates run's (null if not
 * finished): gates must pass before any repair.
 * @returns {{action: "none" | "needs_human" | "repair", reason: string, attempt?: number}}
 */
function repairDecision({ enabled, event, conclusion, headIsCurrent, gates, signature, past, labels, config, spent }) {
    if (!enabled) return { action: "none", reason: 'kill switch: FACTORY_ENABLED is not "true"' };
    if ((labels || []).includes(LABEL_NEEDS_HUMAN)) return { action: "none", reason: "already needs-human" };
    if (event === "merge_group") {
        return conclusion === "failure"
            ? { action: "needs_human", reason: "ci failed on the merge group, so the PR left the merge queue" }
            : { action: "none", reason: `merge group ci ${conclusion}` };
    }
    if (!headIsCurrent) return { action: "none", reason: "stale: the PR head moved since this run" };
    if (gates && gates !== "success") return { action: "needs_human", reason: `gates ${gates} (scope, contracts or policy), which a repair may not change` };
    if (conclusion !== "failure") return { action: "none", reason: `ci ${conclusion || "not finished"}` };
    // A repair only after the policy checks pass; the router runs again when gates completes.
    if (!gates) return { action: "none", reason: "ci failed; waiting for gates on this head" };
    const repairs = (past || []).filter((h) => h.event === "repair");
    if (repairs.length >= config.max_repairs) return { action: "needs_human", reason: `ci failed (${signature}) after ${repairs.length} repairs (max_repairs ${config.max_repairs})` };
    const last = repairs[repairs.length - 1];
    if (last && last.signature === signature) return { action: "needs_human", reason: `ci failed again with the same signature as before the last repair (${signature})` };
    const need = reserveFor("repair", config.caps);
    if (spent + need > config.budget_aic) return { action: "needs_human", reason: `budget: ${spent} AIC spent + ${need} reserved for a repair > ${config.budget_aic}` };
    return { action: "repair", reason: `ci failed (${signature})`, attempt: repairs.length + 2 };
}

/**
 * When a v2-port or v2-repair run completes: hand off to a person if it produced nothing. `title` is the
 * run's display title (the workflows' run-name), `pr` the open v2 PR for the language (null if none),
 * `marker` the router's repair marker for this attempt (its `head` is the head it was dispatched on).
 * @returns {{action: "none" | "needs_human", reason: string, issue?: number, unit?: string}}
 */
function agentRunDecision({ enabled, title, conclusion, pr, marker: m }) {
    const port = /^Port ([a-z]{2}(?:-[a-z]+)?) #([1-9][0-9]{0,8})$/.exec(title || "");
    const fix = /^Repair ([a-z]{2}(?:-[a-z]+)?) #([1-9][0-9]{0,8}) attempt ([2-9])$/.exec(title || "");
    if (!port && !fix) return { action: "none", reason: `not a v2 run title: ${title}` };
    const unit = (port || fix)[1];
    const issue = Number((port || fix)[2]);
    if (!enabled) return { action: "none", reason: 'kill switch: FACTORY_ENABLED is not "true"', issue, unit };
    if (port) {
        return pr ? { action: "none", reason: `v2-port ${conclusion}: PR #${pr.number} is open`, issue, unit } : { action: "needs_human", reason: `v2-port ${conclusion} without opening a PR`, issue, unit };
    }
    if (!m || !pr || m.pr !== pr.number) return { action: "none", reason: "no matching repair dispatch for an open PR", issue, unit };
    return pr.head_sha !== m.head
        ? { action: "none", reason: `v2-repair attempt ${fix[3]} ${conclusion}: pushed ${pr.head_sha}`, issue, unit }
        : { action: "needs_human", reason: `v2-repair attempt ${fix[3]} ${conclusion} without pushing a fix`, issue, unit };
}

// ------------------------------------------------------------------ GitHub I/O

const REPO = process.env.GITHUB_REPOSITORY;

async function api(method, p, body) {
    const res = await fetch(`https://api.github.com${p}`, {
        method,
        headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.status === 204 ? null : res.json();
}

const json = (name) => JSON.parse(process.env[name] || "null");

function loadConfig() {
    const c = json("V2_CONFIG");
    const caps = c && c.caps;
    if (!c || !Array.isArray(c.languages) || !Number.isFinite(c.budget_aic) || !Number.isInteger(c.max_repairs) || !caps || ![caps.port, caps.repair, caps.threat_detection, caps.evals].every(Number.isFinite)) {
        throw new Error("V2_CONFIG (.github/factory/v2.yaml) is malformed");
    }
    return c;
}

function common() {
    const spend = json("V2_SPEND");
    if (!spend || !Number.isFinite(spend.spent)) throw new Error("V2_SPEND is missing: budget unknown");
    return { config: loadConfig(), spent: spend.spent, enabled: process.env.FACTORY_ENABLED === "true", event: JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")) };
}

async function comment(issue, text, mark) {
    await api("POST", `/repos/${REPO}/issues/${issue}/comments`, { body: `${text}\n\n${marker(mark)}` });
}

/** Every page of a list endpoint (at most 10 pages of 100). */
async function all(p) {
    const out = [];
    for (let page = 1; page <= 10; page++) {
        const batch = await api("GET", `${p}${p.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
        out.push(...batch);
        if (batch.length < 100) break;
    }
    return out;
}

const AI_JOBS = ["agent", "detection", "evals"];

async function spend(logsFile) {
    const caps = loadConfig().caps;
    const logs = JSON.parse(fs.readFileSync(logsFile, "utf8"));
    const filesOf = (r) => {
        const dir = r.logs_path && path.join(r.logs_path, "usage");
        const files = {};
        if (!dir || !fs.existsSync(dir)) return files;
        for (const job of fs.readdirSync(dir)) {
            const f = path.join(dir, job, "token_usage.jsonl");
            if (fs.existsSync(f)) files[job] = fs.readFileSync(f, "utf8");
        }
        return files;
    };
    // Jobs that made model calls: the AI jobs that started and weren't skipped (runner metadata).
    const inferred = new Map();
    for (const r of logs.runs || []) {
        if (r.status !== "completed") continue;
        const jobs = (await api("GET", `/repos/${REPO}/actions/runs/${r.run_id}/jobs?per_page=100`)).jobs || [];
        inferred.set(r.run_id, jobs.filter((j) => AI_JOBS.includes(j.name) && j.started_at && j.conclusion !== "skipped").map((j) => j.name));
    }
    const active = [];
    for (const w of Object.values(WORKFLOWS)) {
        for (const status of ["queued", "in_progress", "waiting", "pending"]) {
            const r = await api("GET", `/repos/${REPO}/actions/workflows/${w}/runs?status=${status}&per_page=100`);
            active.push(...(r.workflow_runs || []).map((x) => ({ id: x.id, path: x.path })));
        }
    }
    const s = spendOf({ logs, filesOf, inferredOf: (r) => inferred.get(r.run_id) || AI_JOBS, active, caps });
    for (const r of s.runs) console.error(`run ${r.run_id}: ${r.aic} AIC (${r.how})`);
    console.log(JSON.stringify({ spent: s.spent, runs: s.runs.length }));
}

async function start() {
    const { config, spent, enabled, event } = common();
    const external = json("V2_EXTERNAL") || [];
    const contracts = json("V2_CONTRACTS") || {};
    const issues = (await all(`/repos/${REPO}/issues?labels=${encodeURIComponent(LABEL)}&state=all`)).filter((i) => !i.pull_request && i.user && i.user.login === ROUTER_LOGIN && unitOfIssue(i));
    let units = config.languages;
    let labelled = null;
    if (process.env.GITHUB_EVENT_NAME === "issues") {
        // A person with write access labelled an existing v2 issue: restart that language.
        labelled = issues.find((i) => i.number === event.issue.number);
        if (!labelled) return console.log(`#${event.issue.number} is not a factory-v2 issue: nothing to do`);
        const perm = await api("GET", `/repos/${REPO}/collaborators/${encodeURIComponent(event.sender.login)}/permission`);
        if (!["admin", "maintain", "write"].includes(perm.permission)) return console.log(`${event.sender.login} can't restart a port (${perm.permission})`);
        units = [unitOfIssue(labelled)];
    }
    const open = await all(`/repos/${REPO}/pulls?state=open`);
    for (const unit of units) {
        const issue = labelled || issues.find((i) => unitOfIssue(i) === unit) || null;
        if (issue && !labelled) {
            console.log(`${unit}: issue #${issue.number} exists (a person restarts it with the ${LABEL_READY} label)`);
            continue;
        }
        const pr = open.find((p) => p.user && p.user.login === AGENT_LOGIN && (p.head.ref || "").startsWith(BRANCH_PREFIX) && trailer(p.body, "Factory-Unit") === unit);
        const d = startDecision({ enabled, unit, config, external, contracts, issue, openPr: pr && pr.number, spent });
        if (labelled) await api("DELETE", `/repos/${REPO}/issues/${labelled.number}/labels/${encodeURIComponent(LABEL_READY)}`).catch(() => {});
        if (!d.ok) {
            console.log(`${unit}: not started: ${d.reason}`);
            if (labelled) await comment(labelled.number, `Not restarted: ${d.reason}.`, { event: "start_refused", reason: d.reason });
            continue;
        }
        const number = issue
            ? issue.number
            : (
                  await api("POST", `/repos/${REPO}/issues`, {
                      title: `[factory-v2] port ${unit}`,
                      body: `Factory v2 (docs/factory-v2.md) ports \`${unit}\` (\`contracts/${unit}/\`) in one agent run and one PR, which merges itself once the required checks pass. The router records each decision below. To restart after a stop, add the \`${LABEL_READY}\` label.\n\n${issueMarker(unit)}`,
                      labels: [LABEL],
                  })
              ).number;
        // A person's restart overrides an earlier stop.
        if (labelled) await api("DELETE", `/repos/${REPO}/issues/${number}/labels/${encodeURIComponent(LABEL_NEEDS_HUMAN)}`).catch(() => {});
        const sha = contracts[unit].sha;
        await api("POST", `/repos/${REPO}/actions/workflows/${WORKFLOWS.port}/dispatches`, { ref: "main", inputs: { unit, issue: String(number), contract_sha: sha } });
        await comment(number, `Started: dispatched \`v2-port\` for \`${unit}\` at contracts commit ${sha} (v2 spend so far: ${spent} of ${config.budget_aic} AIC).`, { event: "start", contract_sha: sha, spent });
        console.log(`${unit}: dispatched v2-port (issue #${number}, contracts ${sha})`);
    }
}

/** The newest run of a workflow on a PR head (or null), from runner metadata. */
async function newestRun(workflow, event, pr) {
    const runs = (await api("GET", `/repos/${REPO}/actions/workflows/${workflow}/runs?event=${event}&head_sha=${pr.head.sha}&per_page=50`)).workflow_runs || [];
    return runs.filter((r) => (r.pull_requests || []).some((x) => x.number === pr.number)).sort((x, y) => y.id - x.id)[0] || null;
}

async function v2Pr(prNumber, config) {
    const pr = await api("GET", `/repos/${REPO}/pulls/${prNumber}`);
    const unit = trailer(pr.body, "Factory-Unit");
    const issueNumber = closesIssue(pr.body);
    if (pr.state !== "open" || !pr.user || pr.user.login !== AGENT_LOGIN || !(pr.head.ref || "").startsWith(BRANCH_PREFIX) || !config.languages.includes(unit) || !issueNumber) return null;
    const issue = await api("GET", `/repos/${REPO}/issues/${issueNumber}`);
    if (unitOfIssue(issue) !== unit || !issue.user || issue.user.login !== ROUTER_LOGIN) return null;
    return { pr, unit, issue, issueNumber };
}

async function handOff(issueNumber, prNumber, reason, extra) {
    for (const n of [prNumber, issueNumber].filter(Boolean)) await api("POST", `/repos/${REPO}/issues/${n}/labels`, { labels: [LABEL_NEEDS_HUMAN] });
    await comment(issueNumber, `Stopped and handed to a person${prNumber ? ` (PR #${prNumber} is \`needs-human\`)` : ""}: ${reason}.`, { event: "needs_human", pr: prNumber || null, reason, ...extra });
}

async function repair() {
    const { config, spent, enabled, event } = common();
    const run = event.workflow_run;
    let prNumber = null;
    if (run.event === "merge_group") {
        const m = /^gh-readonly-queue\/main\/pr-(\d+)-[0-9a-f]+$/.exec(run.head_branch || "");
        prNumber = m ? Number(m[1]) : null;
    } else if ((run.event === "pull_request" || run.event === "pull_request_target") && (run.head_branch || "").startsWith(BRANCH_PREFIX)) {
        prNumber = run.pull_requests && run.pull_requests[0] ? run.pull_requests[0].number : null;
    }
    if (!prNumber) return console.log(`${run.name} run ${run.id} (${run.event}, ${run.head_branch}) is not a factory-v2 PR's`);
    const v = await v2Pr(prNumber, config);
    if (!v) return console.log(`PR #${prNumber} is not an open factory-v2 PR (author, branch, Factory-Unit, Closes line or issue): nothing to do`);
    const { pr, unit, issue, issueNumber } = v;
    const past = history(await all(`/repos/${REPO}/issues/${issueNumber}/comments`)).filter((h) => h.pr === prNumber);

    // The newest ci and gates runs on the current head decide, whichever event woke us.
    let ci = null;
    let gates = null;
    let signature = null;
    let headIsCurrent = true;
    let conclusion = run.conclusion;
    if (run.event !== "merge_group") {
        headIsCurrent = run.head_sha === pr.head.sha;
        ci = await newestRun("ci.yml", "pull_request", pr);
        const g = await newestRun("gates.yml", "pull_request_target", pr);
        gates = g && g.status === "completed" ? g.conclusion : null;
        conclusion = ci && ci.status === "completed" ? ci.conclusion : null;
        if (ci && past.some((h) => h.event === "repair" && h.run_id === ci.id)) return console.log(`ci run ${ci.id} was already handled`);
        if (conclusion === "failure") {
            const jobs = await api("GET", `/repos/${REPO}/actions/runs/${ci.id}/jobs`);
            signature = failureSignature((jobs.jobs || []).find((j) => j.name === "checks"));
        }
    }
    const labels = [...(pr.labels || []), ...(issue.labels || [])].map((l) => l.name);
    const d = repairDecision({ enabled, event: run.event, conclusion, headIsCurrent, gates, signature, past, labels, config, spent });
    console.log(`PR #${prNumber} (${unit}), woken by ${run.name} run ${run.id}: ci ${conclusion}, gates ${gates}: ${d.action}: ${d.reason}`);
    if (d.action === "needs_human") {
        await handOff(issueNumber, prNumber, `${d.reason}. Run: ${run.html_url}`, { run_id: run.id });
    } else if (d.action === "repair") {
        await api("POST", `/repos/${REPO}/actions/workflows/${WORKFLOWS.repair}/dispatches`, {
            ref: "main",
            inputs: {
                unit,
                issue: String(issueNumber),
                pr: String(prNumber),
                attempt: String(d.attempt),
                contract_sha: trailer(pr.body, "Contract-SHA") || "",
                head_sha: pr.head.sha,
                failure_signature: signature,
                run_id: String(ci.id),
            },
        });
        await comment(
            issueNumber,
            `Repair ${d.attempt - 1} of ${config.max_repairs}: dispatched \`v2-repair\` for PR #${prNumber} after ${d.reason}. Ci run: ${ci.html_url} (v2 spend so far: ${spent} of ${config.budget_aic} AIC).`,
            { event: "repair", pr: prNumber, run_id: ci.id, head: pr.head.sha, signature, attempt: d.attempt, spent }
        );
    }
}

/** A v2-port or v2-repair run completed: hand off if it produced no PR or no fix. */
async function completed() {
    const { config, enabled, event } = common();
    const run = event.workflow_run;
    if (run.event !== "workflow_dispatch" || run.head_branch !== "main") return console.log(`run ${run.id} is not a router dispatch`);
    const title = run.display_title;
    const parsed = agentRunDecision({ enabled: false, title });
    if (!parsed.issue) return console.log(parsed.reason);
    const issue = await api("GET", `/repos/${REPO}/issues/${parsed.issue}`);
    if (unitOfIssue(issue) !== parsed.unit || !issue.user || issue.user.login !== ROUTER_LOGIN || !config.languages.includes(parsed.unit)) return console.log(`#${parsed.issue} is not ${parsed.unit}'s factory-v2 issue`);
    if ((issue.labels || []).some((l) => l.name === LABEL_NEEDS_HUMAN) || issue.state !== "open") return console.log(`#${parsed.issue} is closed or already needs-human`);
    const open = await all(`/repos/${REPO}/pulls?state=open`);
    const p = open.find((x) => x.user && x.user.login === AGENT_LOGIN && (x.head.ref || "").startsWith(BRANCH_PREFIX) && trailer(x.body, "Factory-Unit") === parsed.unit && closesIssue(x.body) === parsed.issue);
    const attempt = /attempt ([2-9])$/.exec(title);
    const m = attempt ? history(await all(`/repos/${REPO}/issues/${parsed.issue}/comments`)).filter((h) => h.event === "repair" && h.attempt === Number(attempt[1])).pop() : null;
    const d = agentRunDecision({ enabled, title, conclusion: run.conclusion, pr: p && { number: p.number, head_sha: p.head.sha }, marker: m });
    console.log(`${title} (run ${run.id}) ${run.conclusion}: ${d.action}: ${d.reason}`);
    if (d.action === "needs_human") await handOff(parsed.issue, p && p.number, `${d.reason}. Run: ${run.html_url}`, { run_id: run.id });
}

module.exports = { reserveFor, trailer, closesIssue, history, failureSignature, runUsage, spendOf, startDecision, repairDecision, agentRunDecision, marker, issueMarker, unitOfIssue };

if (require.main === module) {
    const [mode, arg] = process.argv.slice(2);
    const fn = { spend: () => spend(arg), start, repair, completed }[mode];
    if (!fn) {
        console.error("usage: router.js spend LOGS.json | start | repair | completed");
        process.exit(2);
    }
    fn().catch((e) => {
        console.log(`::error::factory v2 router (${mode}) failed closed: ${e.message}`);
        process.exitCode = 1;
    });
}
