#!/usr/bin/env node
"use strict";
// Factory watchdog (plain code, no AI; .github/workflows/watchdog.yml, every 15 min). It catches
// stalls that otherwise wait for a person to look, independently of any outside session:
//   - needs-human: an open issue or PR labelled `needs-human` more than 6 h ago (from its latest
//     `labeled` event), so a waiting decision can't sit unnoticed (#457 waited ~40 h);
//   - slow CI: a `ci` run's `checks` job running (or having run) more than 60 min, a warning before
//     its 90-min time limit cancels it (#473's job was cancelled at 90 min).
// Each finding is raised once: one factory:alert issue lists the new findings, and a finding already
// listed in any watchdog alert (open or closed) is not raised again. The titles are not the
// controller's spend-alert titles, so these alerts don't turn the spend bound off.
//
//   node watchdog/watchdog.js plan --out PLAN.json     read-only token: what to raise
//   node watchdog/watchdog.js raise --plan PLAN.json   (live) open the alert issue(s)
//
// Built-ins only (the raise step runs with a write token).
const fs = require("fs");

const REPO = process.env.GITHUB_REPOSITORY || "sabbasi3-factory-lab/chrono-node-rs";
const NEEDS_HUMAN_HOURS = 6;
const CHECKS_WARN_MINUTES = 60;
const CI_LOOKBACK_HOURS = 4;
const MARKER = "<!-- factory-watchdog -->";
const ITEM_RE = /<!-- watchdog-item: ([a-z-]+:[0-9]+(?:@[0-9]+)?) -->/g;
const TITLES = {
    needs_human_stale: `Factory watchdog: needs-human waiting over ${NEEDS_HUMAN_HOURS} h`,
    ci_slow: `Factory watchdog: CI checks job over ${CHECKS_WARN_MINUTES} min`,
};

/**
 * Open needs-human items labelled more than NEEDS_HUMAN_HOURS ago. Pure.
 *   items: [{number, title, is_pr, labeled_at, label_event_id}] (labeled_at: the latest
 *          `labeled needs-human` event)
 */
/** Untrusted text (titles, branch names) for one alert line: no `<` or `>` at all, so it can't open
 *  or close an HTML comment (and forge an item marker) or inject markup. */
const clean = (s) => String(s).replace(/[<>]/g, "").replace(/\s+/g, " ").slice(0, 90);

function staleNeedsHuman(items, now) {
    const limit = NEEDS_HUMAN_HOURS * 3600_000;
    return items
        .filter((i) => i.labeled_at && now - Date.parse(i.labeled_at) > limit)
        .map((i) => ({
            key: `needs-human:${i.number}@${i.label_event_id || 0}`,
            line: `- ${i.is_pr ? "PR" : "issue"} #${i.number} ${JSON.stringify(clean(i.title))}: needs-human for ${Math.floor((now - Date.parse(i.labeled_at)) / 3600_000)} h (since ${i.labeled_at})`,
        }));
}

/**
 * `checks` jobs over CHECKS_WARN_MINUTES (running: until now). Pure.
 *   jobs: [{run_id, name, status, started_at, completed_at, html_url, head_branch, event}]
 */
function slowChecks(jobs, now) {
    const limit = CHECKS_WARN_MINUTES * 60_000;
    return jobs
        .filter((j) => j.name === "checks" && j.started_at)
        .map((j) => ({ ...j, ms: (j.completed_at ? Date.parse(j.completed_at) : now) - Date.parse(j.started_at) }))
        .filter((j) => j.ms > limit)
        .map((j) => ({
            key: `ci-run:${j.run_id}`,
            line: `- run ${j.run_id} (${clean(j.event)} ${clean(j.head_branch)}): \`checks\` ${j.status === "completed" ? "took" : "running for"} ${Math.round(j.ms / 60_000)} min (limit 90): ${j.html_url}`,
        }));
}

/** Finding keys listed in watchdog alert bodies. Pure. */
function raisedKeys(alertBodies) {
    const seen = new Set();
    for (const b of alertBodies) for (const m of (b || "").matchAll(ITEM_RE)) seen.add(m[1]);
    return seen;
}

/** Findings not listed in any earlier watchdog alert body. Pure. */
function unraised(findings, alertBodies) {
    const seen = raisedKeys(alertBodies);
    return findings.filter((f) => !seen.has(f.key));
}

/** CI runs worth a jobs call: active ones (any age: a re-run keeps its old created_at) and runs that
 *  ended within the lookback, whose latest attempt ran longer than the limit. Pure. */
function candidateRuns(runs, now, lookbackMs = CI_LOOKBACK_HOURS * 3600_000) {
    const seen = new Set();
    return runs.filter((r) => {
        if (seen.has(r.id)) return false;
        seen.add(r.id);
        const active = r.status !== "completed";
        if (!active && now - Date.parse(r.updated_at) > lookbackMs) return false;
        return (active ? now : Date.parse(r.updated_at)) - Date.parse(r.run_started_at || r.created_at) > CHECKS_WARN_MINUTES * 60_000;
    });
}

/** The alert issue for one kind of finding. Pure. */
function renderAlert(kind, findings, runUrl) {
    const what =
        kind === "needs_human_stale"
            ? `These have waited for a person more than ${NEEDS_HUMAN_HOURS} h. Work behind them (often a whole language) is stalled until someone decides.`
            : `A \`checks\` job past ${CHECKS_WARN_MINUTES} min is close to its 90-min limit; a cancelled run stalls its task (\`ci_cancelled\`). Look for what got slower (per-step times in the run).`;
    const body = [
        MARKER,
        `**Factory watchdog** (plain code, no AI) · ${kind}`,
        "",
        what,
        "",
        ...findings.map((f) => `${f.line} <!-- watchdog-item: ${f.key} -->`),
        "",
        `Each item is raised once. Close this issue once handled. Run: ${runUrl || "local"}`,
    ].join("\n");
    return { title: TITLES[kind], body: body.slice(0, 60000), labels: ["factory:alert"] };
}

// ---- GitHub (read: the workflow token; raise: the controller App token)

async function gh(method, path, body) {
    const res = await fetch(`https://api.github.com${path}`, {
        method,
        headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "factory-watchdog" },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.json();
}

async function pages(path, pick = (d) => d) {
    const out = [];
    for (let page = 1; page <= 20; page++) {
        const d = pick(await gh("GET", `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`));
        out.push(...d);
        if (d.length < 100) break;
    }
    return out;
}

async function plan() {
    const now = Date.now();
    const open = await pages(`/repos/${REPO}/issues?state=open&labels=needs-human`);
    const items = [];
    for (const i of open) {
        const events = await pages(`/repos/${REPO}/issues/${i.number}/events`);
        const last = events.filter((e) => e.event === "labeled" && e.label && e.label.name === "needs-human").pop();
        items.push({ number: i.number, title: i.title || "", is_pr: Boolean(i.pull_request), labeled_at: last ? last.created_at : i.created_at, label_event_id: last ? last.id : 0 });
    }
    // Active runs of any age (a re-run keeps its original created_at), plus the newest finished ones
    // (one page each; candidateRuns keeps those that ended within the lookback).
    const runs = [];
    for (const status of ["in_progress", "queued", "completed"]) {
        const d = await gh("GET", `/repos/${REPO}/actions/workflows/ci.yml/runs?status=${status}&per_page=100`);
        runs.push(...(d.workflow_runs || []));
    }
    const jobs = [];
    for (const r of candidateRuns(runs, now)) {
        const js = await pages(`/repos/${REPO}/actions/runs/${r.id}/jobs`, (d) => d.jobs || []);
        for (const j of js) jobs.push({ run_id: r.id, name: j.name, status: j.status, started_at: j.started_at, completed_at: j.completed_at, html_url: j.html_url, head_branch: r.head_branch, event: r.event });
    }
    const alerts = (await pages(`/repos/${REPO}/issues?state=all&labels=factory:alert`)).filter((i) => (i.body || "").startsWith(MARKER)).map((i) => i.body);
    const out = {};
    for (const [kind, findings] of [["needs_human_stale", staleNeedsHuman(items, now)], ["ci_slow", slowChecks(jobs, now)]]) {
        const fresh = unraised(findings, alerts);
        console.log(`${kind}: ${findings.length} finding(s), ${fresh.length} new`);
        for (const f of findings) console.log(`  ${f.line}${fresh.includes(f) ? " [new]" : ""}`);
        if (fresh.length > 0) out[kind] = { findings: fresh, run_url: process.env.RUN_URL || null };
    }
    fs.writeFileSync(opt("--out"), JSON.stringify(out, null, 1) + "\n");
}

const KEY_RE = /^(needs-human:[0-9]+@[0-9]+|ci-run:[0-9]+)$/;

/** The planned findings, validated (the plan comes from another job's artifact). Pure. */
function checkPlan(p) {
    for (const [kind, v] of Object.entries(p)) {
        if (!TITLES[kind] || !Array.isArray(v.findings) || v.findings.length === 0) throw new Error(`refusing a malformed ${kind} plan`);
        for (const f of v.findings) {
            if (!KEY_RE.test(f.key || "") || typeof f.line !== "string" || f.line.length > 400 || /[<>]/.test(f.line)) throw new Error(`refusing a malformed ${kind} finding`);
        }
        if (v.run_url !== null && !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/[0-9]+$/.test(v.run_url)) throw new Error("refusing a malformed run url");
    }
    return p;
}

/** Opens the planned alerts. Existing alerts are re-read first: a retried raise (one POST failed
 *  after another succeeded) never raises a finding twice. */
async function raise() {
    const p = checkPlan(JSON.parse(fs.readFileSync(opt("--plan"), "utf8")));
    for (const [kind, v] of Object.entries(p)) {
        const alerts = (await pages(`/repos/${REPO}/issues?state=all&labels=factory:alert`)).filter((i) => (i.body || "").startsWith(MARKER)).map((i) => i.body);
        const fresh = unraised(v.findings, alerts);
        if (fresh.length === 0) {
            console.log(`${kind}: already raised`);
            continue;
        }
        const a = renderAlert(kind, fresh, v.run_url);
        const created = await gh("POST", `/repos/${REPO}/issues`, { title: a.title, body: a.body, labels: a.labels });
        console.log(`opened #${created.number} ${a.title}`);
    }
}

function opt(name) {
    const i = process.argv.indexOf(name);
    if (i < 0 || !process.argv[i + 1]) throw new Error(`${name} is required`);
    return process.argv[i + 1];
}

if (require.main === module) {
    const cmd = { plan, raise }[process.argv[2]];
    if (!cmd) {
        console.error("usage: watchdog.js plan --out F | raise --plan F");
        process.exit(2);
    }
    cmd().catch((e) => {
        console.error(e.message);
        process.exitCode = 1;
    });
}

module.exports = { staleNeedsHuman, slowChecks, unraised, raisedKeys, candidateRuns, checkPlan, renderAlert, TITLES, MARKER, NEEDS_HUMAN_HOURS, CHECKS_WARN_MINUTES };
