#!/usr/bin/env node
"use strict";
// Factory review (Loop 4, DESIGN §15), data step. Plain code, no AI, read-only. Runs before the
// agent (outside its firewall) and writes small, precomputed files the agent reads, so the model
// summarizes evidence instead of fetching or counting.
//
//   node review/gather.js --out DIR --logs DIR [--now ISO]
//
// Inputs: `gh aw logs --json --outcomes` output per AI workflow (--logs DIR, from the workflow step;
// its `outcomes` are gh-aw's per-run verdicts, which the retired outcomes.yml used to collect), the
// `audit` branch (last 7 days), the pinned factory policy
// files' last change dates, and this repo's prompt files' last change dates.
// Outputs (DIR): summary.md (tables + area eligibility + failures + platform reliability), runs.jsonl
// (one compact line per run), outcomes.json (runs in the window), audit-counts.json, areas.json,
// failures.json (each needs-human event attributed: agent, factory, platform or policy, failures.js)
// and platform-reliability.json (failed gh-aw runs by kind).
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const failures = require("./failures");

const REPO_DIR = path.resolve(__dirname, "../..");
const REPO = process.env.GITHUB_REPOSITORY || "sabbasi3-factory-lab/chrono-node-rs";
const WINDOW_DAYS = 7;
const MIN_TASKS = 15;
const POLICIES = ["budgets", "limits", "tiers", "dependencies", "network", "cadence"];
const PROMPTS = { implement: ".github/workflows/implement.md", repair: ".github/workflows/repair.md", review: ".github/workflows/review.md" };

const opt = (name) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : null;
};
const git = (...args) => execFileSync("git", args, { cwd: REPO_DIR, encoding: "utf8", maxBuffer: 1 << 28 }).trim();

async function gh(apiPath, accept = "application/vnd.github+json") {
    const res = await fetch(`https://api.github.com${apiPath}`, { headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept } });
    if (!res.ok) throw new Error(`GET ${apiPath}: ${res.status}`);
    return accept.endsWith("raw") ? res.text() : res.json();
}

/**
 * Non-dry-run audit events from the `audit` branch (fetched by the workflow), `days` back. The
 * window is WINDOW_DAYS; repairs are read 2 days further back, since a task lives at most 24 h
 * (limits.yaml max_wall_clock_hours), so a merge early in the window still sees its repairs.
 */
function auditEvents(now, days = WINDOW_DAYS) {
    const out = [];
    for (let d = 0; d <= days; d++) {
        const day = new Date(now.getTime() - d * 86_400_000).toISOString().slice(0, 10).replace(/-/g, "/");
        let text = "";
        try {
            text = git("show", `origin/audit:audit/${day}.jsonl`);
        } catch {
            continue;
        }
        for (const line of text.split("\n")) if (line.trim()) out.push(JSON.parse(line));
    }
    const since = new Date(now.getTime() - days * 86_400_000).toISOString();
    return out.filter((e) => e.timestamp >= since && e.payload && e.payload.dry_run === false).sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
}

/** When a merge happened: the PR's own merge time, not when the controller recorded it. */
const mergedAt = (e) => e.payload.merged_at || e.timestamp;

/** Counts that matter for a review, from the window's events (+ earlier repairs, for first tries). Pure. */
function auditCounts(events, earlierRepairs = []) {
    const byKey = {};
    const merged = new Set();
    const needsHuman = {};
    const repairsByTask = {};
    for (const e of events) {
        const k = e.payload.reason ? `${e.type}/${e.payload.reason}` : e.type;
        byKey[k] = (byKey[k] || 0) + 1;
        if (e.type === "merged" && e.payload.task) merged.add(e.payload.task);
        if (e.type === "needs_human") needsHuman[e.payload.reason] = (needsHuman[e.payload.reason] || 0) + 1;
        if (e.type === "repair_dispatched" && e.payload.task) repairsByTask[e.payload.task] = (repairsByTask[e.payload.task] || 0) + 1;
    }
    const tasks = [...merged];
    const repairedEver = new Set([...Object.keys(repairsByTask), ...earlierRepairs.filter((e) => e.type === "repair_dispatched" && e.payload.task).map((e) => e.payload.task)]);
    const firstTry = tasks.filter((t) => !repairedEver.has(t)).length;
    return {
        events: events.length,
        by_type_reason: Object.fromEntries(Object.entries(byKey).sort()),
        merged_tasks: tasks.length,
        merged_first_try: firstTry,
        repairs: Object.values(repairsByTask).reduce((a, b) => a + b, 0),
        needs_human_by_reason: needsHuman,
    };
}

/** One compact record per run from `gh aw logs --json`. Pure. */
function compactRuns(logs, workflow) {
    return (logs.runs || []).map((r) => ({
        workflow,
        run_id: r.run_id,
        title: r.workflow_name,
        model: r.model,
        conclusion: r.conclusion,
        duration: r.duration,
        aic: r.aic,
        tokens: r.token_usage,
        turns: r.turns,
        friction_ratio: r.friction ? r.friction.friction_ratio : undefined,
        created_at: r.created_at,
    }));
}

/** Area eligibility: tasks finished (merged) since the area last changed, in the window. Pure. */
function areas(lastChange, events, now) {
    const windowStart = new Date(now.getTime() - WINDOW_DAYS * 86_400_000).toISOString();
    return Object.entries(lastChange).map(([area, changed]) => {
        const from = changed && changed > windowStart ? changed : windowStart;
        const tasks = new Set(events.filter((e) => e.type === "merged" && e.payload.task && mergedAt(e) >= from).map((e) => e.payload.task));
        // An unknown last change is never eligible (fail closed: a lookup error mustn't open an area).
        return { area, last_change: changed, tasks_since: changed ? tasks.size : 0, eligible: Boolean(changed) && tasks.size >= MIN_TASKS };
    });
}

/**
 * gh-aw Outcomes from the `gh aw logs --outcomes` output: one record per run (its items, or the
 * per-run eval_error gh-aw reports, e.g. a missing manifest), and item statuses counted. Pure.
 *   logs: [{runs: [...], outcomes: [{run_id, items: [{type, object_url, outcome_status, zero_touch}], eval_error?}]}]
 */
function outcomesOf(logs) {
    const runs = [];
    const summary = {};
    for (const l of logs) {
        for (const o of Array.isArray(l && l.outcomes) ? l.outcomes : []) {
            if (!o || !Number.isSafeInteger(o.run_id)) continue;
            const items = (Array.isArray(o.items) ? o.items : []).map((i) => ({ type: i.type, object_url: i.object_url || null, outcome_status: i.outcome_status, zero_touch: i.zero_touch ?? null }));
            runs.push({ run_id: o.run_id, workflow: o.workflow || null, items, ...(o.eval_error ? { eval_error: String(o.eval_error) } : {}) });
            for (const i of items) summary[i.outcome_status] = (summary[i.outcome_status] || 0) + 1;
        }
    }
    return { runs, summary };
}

function summaryMd(counts, runs, areaList, outcomes) {
    const lines = [`# Factory review data (${WINDOW_DAYS}-day window, computed by plain code)`, ""];
    lines.push("## Areas (a change may be proposed only where eligible: at least 15 tasks finished since the area last changed)", "", "| area | last change | tasks since | eligible |", "|---|---|---|---|");
    for (const a of areaList) lines.push(`| ${a.area} | ${a.last_change || "unknown"} | ${a.tasks_since} | ${a.eligible ? "yes" : "no"} |`);
    lines.push("", "## Tasks (audit log)", "", `- merged tasks: ${counts.merged_tasks}; merged with no repair: ${counts.merged_first_try}; repairs dispatched: ${counts.repairs}`);
    lines.push(`- needs-human by reason: ${JSON.stringify(counts.needs_human_by_reason)}`);
    lines.push("", "## AI runs (gh aw logs)", "", "| workflow | runs | success | total AIC | median AIC |", "|---|---|---|---|---|");
    const by = {};
    for (const r of runs) (by[r.workflow] ||= []).push(r);
    for (const [wf, rs] of Object.entries(by)) {
        const aic = rs.map((r) => r.aic || 0).sort((a, b) => a - b);
        const mid = aic.length / 2;
        const median = aic.length === 0 ? 0 : aic.length % 2 ? aic[Math.floor(mid)] : (aic[mid - 1] + aic[mid]) / 2;
        lines.push(`| ${wf} | ${rs.length} | ${rs.filter((r) => r.conclusion === "success").length} | ${aic.reduce((a, b) => a + b, 0).toFixed(1)} | ${median.toFixed(1)} |`);
    }
    const unevaluated = outcomes.runs.filter((r) => r.eval_error).length;
    lines.push("", "## Outcomes (gh aw logs --outcomes)", "", `- runs in the window: ${outcomes.runs.length} (${unevaluated} not evaluable); item statuses: ${JSON.stringify(outcomes.summary)}`);
    return lines.join("\n") + "\n";
}

async function main() {
    const out = opt("--out");
    const logsDir = opt("--logs");
    const now = new Date(opt("--now") || Date.now());
    fs.mkdirSync(out, { recursive: true });
    const all = auditEvents(now, WINDOW_DAYS + 2);
    const windowStart = new Date(now.getTime() - WINDOW_DAYS * 86_400_000).toISOString();
    const events = all.filter((e) => e.timestamp >= windowStart);
    const counts = auditCounts(events, all.filter((e) => e.timestamp < windowStart));

    const runs = [];
    const logs = [];
    for (const wf of Object.keys(PROMPTS)) {
        const file = path.join(logsDir, `${wf}.json`);
        try {
            if (!fs.existsSync(file)) continue;
            const l = JSON.parse(fs.readFileSync(file, "utf8"));
            runs.push(...compactRuns(l, wf));
            logs.push(l);
        } catch (e) {
            console.log(`::warning::${wf} logs unreadable (${e.message}): its runs are missing from the data`);
        }
    }

    const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000).toISOString();
    const outcomes = outcomesOf(logs);

    // Last change per area: prompts here; policies in the factory repo at the pinned version.
    const lastChange = {};
    for (const [name, file] of Object.entries(PROMPTS)) lastChange[`prompt:${name}`] = git("log", "-1", "--format=%cI", "--", file) || null;
    const pin = fs.readFileSync(path.join(REPO_DIR, ".github/factory/factory-version"), "utf8").trim();
    for (const p of POLICIES) {
        try {
            const c = await gh(`/repos/sabbasi3-factory-lab/factory/commits?path=policies/${p}.yaml&sha=${pin}&per_page=1`);
            lastChange[`policy:${p}`] = c[0] ? new Date(c[0].commit.committer.date).toISOString() : null;
        } catch {
            lastChange[`policy:${p}`] = null;
        }
    }
    const areaList = areas(Object.fromEntries(Object.entries(lastChange).map(([k, v]) => [k, v ? new Date(v).toISOString() : null])), events, now);

    // Failures: where each failed gh-aw run stopped, and who caused each needs-human (failures.js).
    const workflows = fs
        .readdirSync(path.join(REPO_DIR, ".github/workflows"))
        .filter((f) => f.endsWith(".lock.yml"))
        .sort()
        .map((file) => {
            const name = file.replace(/\.lock\.yml$/, "");
            // Fails the step if unreadable: the factory's own steps mustn't be counted as gh-aw's.
            const fm = failures.frontmatterOf(fs.readFileSync(path.join(REPO_DIR, ".github/workflows", `${name}.md`), "utf8"));
            return { name, file, factorySteps: failures.factoryStepNames(fm) };
        });
    const fd = await failures.fetchFailureData({ gh, repo: REPO, since, workflows, events });
    const runById = new Map(fd.runs.map((r) => [r.run_id, r]));
    for (const r of runs) {
        const f = runById.get(r.run_id);
        if (f) Object.assign(r, { failure_class: f.class, failure_kind: f.kind });
    }
    const incidentEvents = all.filter((e) => e.type === "human_action" && e.payload.action === "infra_incident");
    const dispatches = all.filter((e) => e.type === "repair_dispatched");
    const attributed = failures.attributeFailures({ events, incidentEvents, dispatches, labeled: fd.labeled, runs: runById, triage: fd.triage });
    const reliability = failures.platformReliability(fd.runs, { from: since, to: now.toISOString() });

    fs.writeFileSync(path.join(out, "failures.json"), JSON.stringify(attributed, null, 1) + "\n");
    fs.writeFileSync(path.join(out, "platform-reliability.json"), JSON.stringify(reliability, null, 1) + "\n");
    fs.writeFileSync(path.join(out, "runs.jsonl"), runs.map((r) => JSON.stringify(r)).join("\n") + "\n");
    fs.writeFileSync(path.join(out, "outcomes.json"), JSON.stringify(outcomes, null, 1) + "\n");
    fs.writeFileSync(path.join(out, "audit-counts.json"), JSON.stringify(counts, null, 1) + "\n");
    fs.writeFileSync(path.join(out, "areas.json"), JSON.stringify(areaList, null, 1) + "\n");
    fs.writeFileSync(path.join(out, "summary.md"), summaryMd(counts, runs, areaList, outcomes) + failures.failuresMd(attributed, reliability));
    const eligible = areaList.filter((a) => a.eligible).map((a) => a.area);
    console.log(`eligible areas: ${eligible.join(", ") || "none"}`);
    console.log(`platform failures: ${reliability.platform_failures}; recurring kinds: ${reliability.recurring.join(", ") || "none"}`);
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `eligible=${eligible.length}\nplatform_failures=${reliability.platform_failures}\n`);
}

module.exports = { auditCounts, compactRuns, areas, summaryMd, outcomesOf };

if (require.main === module) {
    main().catch((e) => {
        console.error(e.message);
        process.exitCode = 1;
    });
}
