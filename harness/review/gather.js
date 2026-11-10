#!/usr/bin/env node
"use strict";
// Factory review (Loop 4, DESIGN §15), data step. Plain code, no AI, read-only. Runs before the
// agent (outside its firewall) and writes small, precomputed files the agent reads, so the model
// summarizes evidence instead of fetching or counting.
//
//   node review/gather.js --out DIR --logs DIR --outcomes DIR [--now ISO]
//
// Inputs: `gh aw logs --json` output per prompt workflow (--logs DIR), one file per completed AI run
// with its gh-aw Outcomes verdict from `gh aw logs --outcomes` or the eval_error saying why it has
// none (--outcomes DIR, both from the workflow step; the retired outcomes.yml used to collect them), the
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
 * gh-aw Outcomes, one record per run: its items, or an eval_error (gh-aw's own, e.g. a missing
 * manifest, or the workflow step's, e.g. over the cap), so missing evidence is never an empty
 * result. Item statuses counted; unevaluated runs counted by reason. Pure.
 *   records: [{run_id, workflow, outcome?: {workflow, items: [{type, object_url, outcome_status, zero_touch}], eval_error?}, eval_error?}]
 */
function outcomesOf(records) {
    const runs = [];
    const summary = {};
    const not_evaluated = {};
    for (const r of records) {
        if (!r || !Number.isSafeInteger(r.run_id)) continue;
        const o = r.outcome && typeof r.outcome === "object" ? r.outcome : null;
        const items = (o && Array.isArray(o.items) ? o.items : []).map((i) => ({ type: i.type, object_url: i.object_url || null, outcome_status: i.outcome_status, zero_touch: i.zero_touch ?? null }));
        const error = r.eval_error || (o ? o.eval_error : "no Outcomes in the gh aw logs output");
        runs.push({ run_id: r.run_id, workflow: r.workflow || null, title: (o && o.workflow) || null, items, ...(error ? { eval_error: String(error) } : {}) });
        for (const i of items) summary[i.outcome_status] = (summary[i.outcome_status] || 0) + 1;
        if (error) {
            const reason = String(error).replace(/\d+ API requests left/, "N API requests left");
            not_evaluated[reason] = (not_evaluated[reason] || 0) + 1;
        }
    }
    runs.sort((a, b) => b.run_id - a.run_id);
    return { runs, summary, not_evaluated };
}

/** Read --outcomes DIR (one <run_id>.json per run); an unreadable file is kept as an eval_error. */
function readOutcomeRecords(dir) {
    if (!dir || !fs.existsSync(dir)) {
        console.log("::warning::no Outcomes directory: every run's Outcomes are missing from the data");
        return [];
    }
    return fs
        .readdirSync(dir)
        .filter((f) => /^\d+\.json$/.test(f))
        .map((f) => {
            try {
                return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
            } catch (e) {
                return { run_id: Number(f.replace(/\.json$/, "")), workflow: null, eval_error: `unreadable Outcomes file (${e.message})` };
            }
        });
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
    lines.push("", "## Outcomes (gh aw logs --outcomes)", "", `- runs in the window: ${outcomes.runs.length} (${unevaluated} without a verdict); item statuses: ${JSON.stringify(outcomes.summary)}`);
    if (unevaluated) lines.push(`- without a verdict, by reason: ${JSON.stringify(outcomes.not_evaluated)}`);
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
    for (const wf of Object.keys(PROMPTS)) {
        const file = path.join(logsDir, `${wf}.json`);
        try {
            if (!fs.existsSync(file)) continue;
            const l = JSON.parse(fs.readFileSync(file, "utf8"));
            runs.push(...compactRuns(l, wf));
        } catch (e) {
            console.log(`::warning::${wf} logs unreadable (${e.message}): its runs are missing from the data`);
        }
    }

    const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000).toISOString();
    const outcomes = outcomesOf(readOutcomeRecords(opt("--outcomes")));

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

module.exports = { auditCounts, compactRuns, areas, summaryMd, outcomesOf, readOutcomeRecords };

if (require.main === module) {
    main().catch((e) => {
        console.error(e.message);
        process.exitCode = 1;
    });
}
