#!/usr/bin/env node
"use strict";
// Factory watchdog (plain code, no AI; .github/workflows/watchdog.yml, every 15 min). It catches
// stalls that otherwise wait for a person to look, independently of any outside session:
//   - needs-human: an open issue or PR labelled `needs-human` more than 6 h ago (from its latest
//     `labeled` event), so a waiting decision can't sit unnoticed (#457 waited ~40 h);
//   - slow CI: a `ci` run's `checks` job running (or having run) more than 60 min, a warning before
//     its 90-min time limit cancels it (#473's job was cancelled at 90 min);
//   - unlabelled stalls (nothing says needs-human, yet nothing moves):
//     - a factory PR whose `ci` passed on its head over 2 h ago, not in the merge queue or merged
//       (#477: green, but the controller held it on a stale task_timeout; or its gates never ran);
//     - a picked task issue with no controller progress event for over 6 h (from the audit branch:
//       events naming the task, its issue or its PRs; measurements and advisory triage don't count).
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
const ITEM_RE = /<!-- watchdog-item: ([a-z-]+:[0-9]+(?:@[0-9a-f]+)?) -->/g;
const GREEN_STALL_HOURS = 2;
/** The audit is read back at most this far (a stall older than this keeps its key from the floor). */
const AUDIT_MAX_DAYS = 30;
const NO_PROGRESS_HOURS = 6;
/** Audit event types that aren't progress: measurements, heartbeats, and advisory triage. */
const PASSIVE_EVENTS = new Set(["heartbeat", "spend_snapshot", "run_spend", "triage_dispatched", "alert", "dispatch_state"]);
const TITLES = {
    needs_human_stale: `Factory watchdog: needs-human waiting over ${NEEDS_HUMAN_HOURS} h`,
    ci_slow: `Factory watchdog: CI checks job over ${CHECKS_WARN_MINUTES} min`,
    pr_green_stalled: `Factory watchdog: green factory PR not merging for over ${GREEN_STALL_HOURS} h`,
    task_no_progress: `Factory watchdog: in-flight task with no controller progress for over ${NO_PROGRESS_HOURS} h`,
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

/** `Factory-Task:` trailer of a PR body (the controller's link from a PR to its task), or null. Pure. */
function taskOf(body) {
    const m = /^Factory-Task:[ \t]*(\S+)[ \t]*$/m.exec(body || "");
    return m ? m[1] : null;
}

/**
 * Factory PRs green on their head for over GREEN_STALL_HOURS, yet not queued or merged. Pure.
 *   prs: [{number, title, head_sha, in_merge_queue, labels, ci: {conclusion, completed_at} | null,
 *          gates: string | null}]  (ci: the newest `pull_request` ci run on the head; gates: its conclusion)
 * Needs-human PRs are left to the needs-human rule.
 */
function greenStalled(prs, now) {
    const limit = GREEN_STALL_HOURS * 3600_000;
    return prs
        .filter((p) => !p.in_merge_queue && !p.labels.includes("needs-human") && p.ci && p.ci.conclusion === "success" && p.ci.completed_at && now - Date.parse(p.ci.completed_at) > limit)
        .map((p) => ({
            key: `pr-green:${p.number}@${p.head_sha.slice(0, 12)}`,
            line: `- PR #${p.number} ${JSON.stringify(clean(p.title))}: ci green since ${p.ci.completed_at} (${Math.floor((now - Date.parse(p.ci.completed_at)) / 3600_000)} h), gates ${clean(p.gates || "never ran")}, not in the merge queue`,
        }));
}

/**
 * Picked task issues with no progress event for over NO_PROGRESS_HOURS. Pure.
 *   issues: [{number, title, task, since}]  (since: the latest reopen or `factory:picked` label)
 *   events: audit events [{type, timestamp, payload}]; prsByTask: Map task → [PR number]
 * Progress: a non-passive event naming the task, the issue, or one of the task's PRs.
 */
function noProgress(issues, events, prsByTask, now) {
    const limit = NO_PROGRESS_HOURS * 3600_000;
    const out = [];
    for (const i of issues) {
        const prs = new Set(prsByTask.get(i.task) || []);
        let last = i.since;
        for (const e of events) {
            if (PASSIVE_EVENTS.has(e.type)) continue;
            const p = e.payload || {};
            const named = p.task === i.task || p.issue === i.number || prs.has(p.pr) || (Array.isArray(p.prs) && p.prs.some((n) => prs.has(n)));
            if (named && (!last || e.timestamp > last)) last = e.timestamp;
        }
        if (!last || now - Date.parse(last) <= limit) continue;
        out.push({
            key: `no-progress:${i.number}@${Math.floor(Date.parse(last) / 1000)}`,
            line: `- issue #${i.number} ${JSON.stringify(clean(i.title))}: picked, last controller progress ${last} (${Math.floor((now - Date.parse(last)) / 3600_000)} h ago)`,
        });
    }
    return out;
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
        {
            needs_human_stale: `These have waited for a person more than ${NEEDS_HUMAN_HOURS} h. Work behind them (often a whole language) is stalled until someone decides.`,
            ci_slow: `A \`checks\` job past ${CHECKS_WARN_MINUTES} min is close to its 90-min limit; a cancelled run stalls its task (\`ci_cancelled\`). Look for what got slower (per-step times in the run).`,
            pr_green_stalled: `These factory PRs passed \`ci\` over ${GREEN_STALL_HOURS} h ago but aren't in the merge queue, and nothing labels them needs-human. Check the controller's decision for the task (its summary) and the PR's \`gates\` run.`,
            task_no_progress: `These tasks are picked, but the controller recorded nothing for them for over ${NO_PROGRESS_HOURS} h, and nothing labels them needs-human. Check the controller's decision for each (its summary) and its implement run.`,
        }[kind];
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
    const { prs, prsByTask } = await factoryPrs();
    const picked = await pickedIssues();
    const events = await auditEvents(now, picked.map((i) => i.since));
    const alerts = (await pages(`/repos/${REPO}/issues?state=all&labels=factory:alert`)).filter((i) => (i.body || "").startsWith(MARKER)).map((i) => i.body);
    const out = {};
    for (const [kind, findings] of [
        ["needs_human_stale", staleNeedsHuman(items, now)],
        ["ci_slow", slowChecks(jobs, now)],
        ["pr_green_stalled", greenStalled(prs, now)],
        ["task_no_progress", noProgress(picked, events, prsByTask, now)],
    ]) {
        const fresh = unraised(findings, alerts);
        console.log(`${kind}: ${findings.length} finding(s), ${fresh.length} new`);
        for (const f of findings) console.log(`  ${f.line}${fresh.includes(f) ? " [new]" : ""}`);
        if (fresh.length > 0) out[kind] = { findings: fresh, run_url: process.env.RUN_URL || null };
    }
    fs.writeFileSync(opt("--out"), JSON.stringify(out, null, 1) + "\n");
}

/** Open factory PRs (head `factory/…`) with their queue state, newest ci run on the head, and gates. */
async function factoryPrs() {
    const q = `query($o:String!,$n:String!){repository(owner:$o,name:$n){pullRequests(states:OPEN,first:100){nodes{number title body headRefName headRefOid isInMergeQueue labels(first:30){nodes{name}}}}}}`;
    const [o, n] = REPO.split("/");
    const d = await gh("POST", "/graphql", { query: q, variables: { o, n } });
    if (d.errors) throw new Error(`graphql: ${JSON.stringify(d.errors).slice(0, 200)}`);
    const nodes = d.data.repository.pullRequests.nodes.filter((p) => p.headRefName.startsWith("factory/"));
    const gates = (await gh("GET", `/repos/${REPO}/actions/workflows/gates.yml/runs?event=pull_request_target&per_page=100`)).workflow_runs || [];
    const prs = [];
    const prsByTask = new Map();
    for (const p of nodes) {
        const task = taskOf(p.body);
        if (task) prsByTask.set(task, [...(prsByTask.get(task) || []), p.number]);
        const runs = ((await gh("GET", `/repos/${REPO}/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${p.headRefOid}&per_page=20`)).workflow_runs || []).sort((a, b) => b.id - a.id);
        const ci = runs[0] && runs[0].status === "completed" ? { conclusion: runs[0].conclusion, completed_at: runs[0].updated_at } : null;
        const g = gates.filter((r) => (r.pull_requests || []).some((x) => x.number === p.number && x.head && x.head.sha === p.headRefOid)).sort((a, b) => b.id - a.id)[0];
        prs.push({ number: p.number, title: p.title || "", head_sha: p.headRefOid, in_merge_queue: p.isInMergeQueue === true, labels: p.labels.nodes.map((l) => l.name), ci, gates: g ? g.conclusion || g.status : null });
    }
    return { prs, prsByTask };
}

/** Open task issues labelled factory:picked (and not needs-human), with their task and `since`. */
async function pickedIssues() {
    const out = [];
    for (const i of await pages(`/repos/${REPO}/issues?state=open&labels=factory:task,factory:picked`)) {
        if (i.pull_request || (i.labels || []).some((l) => l.name === "needs-human")) continue;
        const m = /<!-- factory-task: ([a-z0-9_/-]+) -->/.exec(i.body || "");
        if (!m) continue;
        const events = await pages(`/repos/${REPO}/issues/${i.number}/events`);
        const marks = events.filter((e) => e.event === "reopened" || (e.event === "labeled" && e.label && e.label.name === "factory:picked")).map((e) => e.created_at);
        out.push({ number: i.number, title: i.title || "", task: m[1], since: marks.sort().pop() || i.created_at });
    }
    return out;
}

/** Audit day files to read: from the earliest floor's day through today (at most AUDIT_MAX_DAYS). Pure. */
function auditDays(floors, now) {
    const today = Date.parse(new Date(now).toISOString().slice(0, 10));
    const first = Math.min(today - 86400_000, ...floors.map((f) => Date.parse(f.slice(0, 10))).filter(Number.isFinite));
    const days = [];
    for (let t = Math.max(first, today - (AUDIT_MAX_DAYS - 1) * 86400_000); t <= today; t += 86400_000) days.push(new Date(t).toISOString().slice(0, 10).replace(/-/g, "/"));
    return days;
}

/**
 * The audit branch's events back to the earliest picked task's floor (its latest reopen or pick), so a
 * task's last progress is found however long it has been stalled: an aging-out day file must not move
 * a stall's key and raise it again. A missing day file is empty.
 */
async function auditEvents(now, floors) {
    const out = [];
    for (const day of auditDays(floors, now)) {
        const res = await fetch(`https://api.github.com/repos/${REPO}/contents/audit/${day}.jsonl?ref=audit`, {
            headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: "application/vnd.github.raw", "x-github-api-version": "2022-11-28", "user-agent": "factory-watchdog" },
        });
        if (res.status === 404) continue;
        if (!res.ok) throw new Error(`audit ${day}: ${res.status}`);
        for (const line of (await res.text()).split("\n")) if (line.trim()) out.push(JSON.parse(line));
    }
    return out;
}

const GATE_MINUTES = 10;
const FINDINGS_STEP = "Findings (read-only)";

/**
 * Did another watchdog run evaluate (its Findings step succeeded) within GATE_MINUTES? Pure.
 *   runs: [{id, jobs: [{steps: [{name, conclusion, completed_at}]}]}]
 * Only an evaluation counts: a run that skipped (Findings `skipped`) must not move the window, or
 * back-to-back skips would suppress evaluations forever.
 */
function recentlyEvaluated(runs, selfId, now) {
    const since = now - GATE_MINUTES * 60_000;
    return runs.some((r) => r.id !== selfId && (r.jobs || []).some((j) => (j.steps || []).some((s) => s.name === FINDINGS_STEP && s.conclusion === "success" && s.completed_at && Date.parse(s.completed_at) >= since)));
}

/** Exit 0 if a recent evaluation makes this run unnecessary, 1 otherwise (errors: 1, i.e. evaluate). */
async function recent() {
    const self = Number(opt("--self"));
    const now = Date.now();
    const d = await gh("GET", `/repos/${REPO}/actions/workflows/watchdog.yml/runs?per_page=20`);
    const runs = [];
    for (const r of (d.workflow_runs || []).filter((r) => r.id !== self && now - Date.parse(r.updated_at) <= GATE_MINUTES * 60_000)) {
        runs.push({ id: r.id, jobs: (await gh("GET", `/repos/${REPO}/actions/runs/${r.id}/jobs`)).jobs || [] });
    }
    process.exitCode = recentlyEvaluated(runs, self, now) ? 0 : 1;
}

const KEY_RE = /^(needs-human:[0-9]+@[0-9]+|ci-run:[0-9]+|pr-green:[0-9]+@[0-9a-f]{7,40}|no-progress:[0-9]+@[0-9]+)$/;

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
    const cmd = { plan, raise, recent }[process.argv[2]];
    if (!cmd) {
        console.error("usage: watchdog.js plan --out F | raise --plan F | recent --self RUN_ID");
        process.exit(2);
    }
    cmd().catch((e) => {
        console.error(e.message);
        // `recent` failing closed means "evaluate"; exit 1 here too.
        process.exitCode = 1;
    });
}

module.exports = { recentlyEvaluated, staleNeedsHuman, slowChecks, greenStalled, noProgress, taskOf, auditDays, PASSIVE_EVENTS, unraised, raisedKeys, candidateRuns, checkPlan, renderAlert, TITLES, MARKER, NEEDS_HUMAN_HOURS, CHECKS_WARN_MINUTES };
