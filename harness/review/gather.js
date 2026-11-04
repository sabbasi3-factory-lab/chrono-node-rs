#!/usr/bin/env node
"use strict";
// Factory review (Loop 4, DESIGN §15), data step. Plain code, no AI, read-only. Runs before the
// agent (outside its firewall) and writes small, precomputed files the agent reads, so the model
// summarizes evidence instead of fetching or counting.
//
//   node review/gather.js --out DIR --logs DIR [--now ISO]
//
// Inputs: `gh aw logs --json` output per AI workflow (--logs DIR, from the workflow step), the
// `outcomes` branch's outcomes.json, the `audit` branch (last 7 days), the pinned factory policy
// files' last change dates, and this repo's prompt files' last change dates.
// Outputs (DIR): summary.md (tables + area eligibility), runs.jsonl (one compact line per run),
// outcomes.json (runs in the window), audit-counts.json, areas.json.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

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

/** Audit events of the window (non-dry-run), from the `audit` branch (fetched by the workflow). */
function auditEvents(now) {
    const out = [];
    for (let d = 0; d <= WINDOW_DAYS; d++) {
        const day = new Date(now.getTime() - d * 86_400_000).toISOString().slice(0, 10).replace(/-/g, "/");
        let text = "";
        try {
            text = git("show", `origin/audit:audit/${day}.jsonl`);
        } catch {
            continue;
        }
        for (const line of text.split("\n")) if (line.trim()) out.push(JSON.parse(line));
    }
    const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000).toISOString();
    return out.filter((e) => e.timestamp >= since && e.payload && e.payload.dry_run === false).sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
}

/** Counts that matter for a review, from the audit events. Pure. */
function auditCounts(events) {
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
    const firstTry = tasks.filter((t) => !repairsByTask[t]).length;
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
        turns: r.friction && r.friction.cost ? r.friction.cost.turns : undefined,
        friction_ratio: r.friction ? r.friction.friction_ratio : undefined,
        created_at: r.created_at,
    }));
}

/** Area eligibility: tasks finished (merged) since the area last changed, in the window. Pure. */
function areas(lastChange, events, now) {
    const windowStart = new Date(now.getTime() - WINDOW_DAYS * 86_400_000).toISOString();
    return Object.entries(lastChange).map(([area, changed]) => {
        const from = changed && changed > windowStart ? changed : windowStart;
        const tasks = new Set(events.filter((e) => e.type === "merged" && e.payload.task && e.timestamp >= from).map((e) => e.payload.task));
        // An unknown last change is never eligible (fail closed: a lookup error mustn't open an area).
        return { area, last_change: changed, tasks_since: changed ? tasks.size : 0, eligible: Boolean(changed) && tasks.size >= MIN_TASKS };
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
        lines.push(`| ${wf} | ${rs.length} | ${rs.filter((r) => r.conclusion === "success").length} | ${aic.reduce((a, b) => a + b, 0).toFixed(1)} | ${(aic[Math.floor(aic.length / 2)] || 0).toFixed(1)} |`);
    }
    lines.push("", "## Outcomes (gh aw outcomes, outcomes branch)", "", `- runs in the window: ${outcomes.runs.length}; item statuses: ${JSON.stringify(outcomes.summary)}`);
    return lines.join("\n") + "\n";
}

async function main() {
    const out = opt("--out");
    const logsDir = opt("--logs");
    const now = new Date(opt("--now") || Date.now());
    fs.mkdirSync(out, { recursive: true });
    const events = auditEvents(now);
    const counts = auditCounts(events);

    const runs = [];
    for (const wf of Object.keys(PROMPTS)) {
        const file = path.join(logsDir, `${wf}.json`);
        try {
            if (fs.existsSync(file)) runs.push(...compactRuns(JSON.parse(fs.readFileSync(file, "utf8")), wf));
        } catch (e) {
            console.log(`::warning::${wf} logs unreadable (${e.message}): its runs are missing from the data`);
        }
    }

    const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000).toISOString();
    let outcomes = { runs: [], summary: {} };
    try {
        const all = JSON.parse(await gh(`/repos/${REPO}/contents/outcomes.json?ref=outcomes`, "application/vnd.github.raw"));
        const recent = (all.runs || []).filter((r) => (r.created_at || "") >= since);
        const summary = {};
        for (const r of recent) for (const i of r.items || []) summary[i.outcome_status] = (summary[i.outcome_status] || 0) + 1;
        outcomes = { runs: recent, summary };
    } catch (e) {
        console.log(`outcomes unavailable (${e.message})`);
    }

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

    fs.writeFileSync(path.join(out, "runs.jsonl"), runs.map((r) => JSON.stringify(r)).join("\n") + "\n");
    fs.writeFileSync(path.join(out, "outcomes.json"), JSON.stringify(outcomes, null, 1) + "\n");
    fs.writeFileSync(path.join(out, "audit-counts.json"), JSON.stringify(counts, null, 1) + "\n");
    fs.writeFileSync(path.join(out, "areas.json"), JSON.stringify(areaList, null, 1) + "\n");
    fs.writeFileSync(path.join(out, "summary.md"), summaryMd(counts, runs, areaList, outcomes));
    const eligible = areaList.filter((a) => a.eligible).map((a) => a.area);
    console.log(`eligible areas: ${eligible.join(", ") || "none"}`);
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `eligible=${eligible.length}\n`);
}

module.exports = { auditCounts, compactRuns, areas, summaryMd };

if (require.main === module) {
    main().catch((e) => {
        console.error(e.message);
        process.exitCode = 1;
    });
}
