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
function staleNeedsHuman(items, now) {
    const limit = NEEDS_HUMAN_HOURS * 3600_000;
    return items
        .filter((i) => i.labeled_at && now - Date.parse(i.labeled_at) > limit)
        .map((i) => ({
            key: `needs-human:${i.number}@${i.label_event_id || 0}`,
            line: `- ${i.is_pr ? "PR" : "issue"} #${i.number} ${JSON.stringify(i.title.slice(0, 90))}: needs-human for ${Math.floor((now - Date.parse(i.labeled_at)) / 3600_000)} h (since ${i.labeled_at})`,
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
            line: `- run ${j.run_id} (${j.event} ${j.head_branch}): \`checks\` ${j.status === "completed" ? "took" : "running for"} ${Math.round(j.ms / 60_000)} min (limit 90): ${j.html_url}`,
        }));
}

/** Findings not listed in any earlier watchdog alert body. Pure. */
function unraised(findings, alertBodies) {
    const seen = new Set();
    for (const b of alertBodies) for (const m of (b || "").matchAll(ITEM_RE)) seen.add(m[1]);
    return findings.filter((f) => !seen.has(f.key));
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
    const since = new Date(now - CI_LOOKBACK_HOURS * 3600_000).toISOString();
    const runs = await pages(`/repos/${REPO}/actions/workflows/ci.yml/runs?created=%3E%3D${encodeURIComponent(since)}`, (d) => d.workflow_runs || []);
    const jobs = [];
    for (const r of runs) {
        // A run shorter than the limit can't contain a slow job: skip its jobs call.
        if ((r.status === "completed" ? Date.parse(r.updated_at) : now) - Date.parse(r.run_started_at || r.created_at) <= CHECKS_WARN_MINUTES * 60_000) continue;
        const js = await pages(`/repos/${REPO}/actions/runs/${r.id}/jobs`, (d) => d.jobs || []);
        for (const j of js) jobs.push({ run_id: r.id, name: j.name, status: j.status, started_at: j.started_at, completed_at: j.completed_at, html_url: j.html_url, head_branch: r.head_branch, event: r.event });
    }
    const alerts = (await pages(`/repos/${REPO}/issues?state=all&labels=factory:alert`)).filter((i) => (i.body || "").startsWith(MARKER)).map((i) => i.body);
    const out = {};
    for (const [kind, findings] of [["needs_human_stale", staleNeedsHuman(items, now)], ["ci_slow", slowChecks(jobs, now)]]) {
        const fresh = unraised(findings, alerts);
        console.log(`${kind}: ${findings.length} finding(s), ${fresh.length} new`);
        for (const f of findings) console.log(`  ${f.line}${fresh.includes(f) ? " [new]" : ""}`);
        if (fresh.length > 0) out[kind] = renderAlert(kind, fresh, process.env.RUN_URL);
    }
    fs.writeFileSync(opt("--out"), JSON.stringify(out, null, 1) + "\n");
}

/** Opens the planned alerts; checks every field against the shapes `renderAlert` produces. */
async function raise() {
    const p = JSON.parse(fs.readFileSync(opt("--plan"), "utf8"));
    for (const [kind, a] of Object.entries(p)) {
        if (!TITLES[kind] || a.title !== TITLES[kind] || typeof a.body !== "string" || !a.body.startsWith(MARKER) || a.body.length > 60000 || JSON.stringify(a.labels) !== '["factory:alert"]') {
            throw new Error(`refusing a malformed ${kind} alert`);
        }
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

module.exports = { staleNeedsHuman, slowChecks, unraised, renderAlert, TITLES, MARKER, NEEDS_HUMAN_HOURS, CHECKS_WARN_MINUTES };
