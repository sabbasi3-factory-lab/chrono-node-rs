"use strict";
// Factory review data step, part 2: who caused each failure. Plain code, no AI, read-only.
//
// Separates agent failures from factory and platform (gh-aw / GitHub) failures, so the review never
// attributes a failure by timing alone. Signals, strongest first:
//   1. a person's infra-incident record (factory:infra-incident + `Infra incident: <ref>`, recorded by
//      the controller as human_action/infra_incident);
//   2. where the failed AI run stopped (Actions jobs API): a gh-aw setup step before the agent ran
//      (e.g. `Start MCP Gateway`), a threat-detection run with no result, or a factory-owned step;
//   3. the needs-human reason code itself, when it names a factory control (e.g. missing_heldout_seed);
//   4. the pre-triage agent's verdict (`**Likely cause:** \`<class>\``, AI and advisory).
// Also counts gh-aw/platform failures by kind (platform-reliability.json), flagging repeats.

const RECUR_AT = 2;
// triage.md posts with the Actions token (no App): only this repo's workflows comment as github-actions[bot],
// and gh-aw stamps the publishing workflow in the body.
const TRIAGE_BOT = "github-actions[bot]";
const INFRA_LABEL = "factory:infra-incident";
const TRIAGE_CLASSES = new Set(["port-bug", "shared-infra-gap", "contract-or-golden", "flaky-or-infra", "policy-hold", "unclear"]);

/** The needs-human reason codes that name a factory control or a policy hold, not agent work. */
const REASON_CLASS = {
    missing_failure_signature: "factory",
    missing_heldout_seed: "factory",
    pick_time_unknown: "factory",
    task_budget_unknown: "factory",
    repair_unavailable: "factory",
    full_regression_missing: "factory",
    review_contract_changed: "factory",
    revert_head_changed: "factory",
    code_scanning_failed: "factory",
    enqueue_failed: "factory",
    invalid_contract: "factory",
    missing_task_marker: "factory",
    duplicate_task: "factory",
    contract_missing: "factory",
    ci_not_repairable: "factory_or_platform",
    ci_cancelled: "factory_or_platform",
    task_budget_exhausted: "policy",
    task_timeout: "policy",
    intake_fix_daily_cap: "policy",
    onboarding_daily_cap: "policy",
    gates_failed: "agent",
    repeated_signature: "agent",
    max_repairs: "agent",
    implement_no_pr: "agent",
    repair_no_push: "agent",
    review_objected: "agent",
    code_scanning_alerts: "agent",
    main_regressed: "agent",
    // Depend on where the run stopped (signal 2) or the pre-triage verdict; otherwise unclear.
    implement_failed: "run",
    repair_failed: "run",
    review_timeout: "run",
};

const TRIAGE_ATTRIBUTION = {
    "port-bug": "agent",
    "shared-infra-gap": "factory",
    "contract-or-golden": "factory",
    "flaky-or-infra": "factory_or_platform",
    "policy-hold": "policy",
    unclear: "unclear",
};

/** Stable names for known gh-aw failure points; anything else is a slug of the step name. */
const KNOWN_KINDS = { "Start MCP Gateway": "mcp_gateway_start" };
const slug = (s) => String(s || "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
const kindOf = (prefix, step) => KNOWN_KINDS[step] || `${prefix}:${slug(step)}`;

/**
 * Step names the factory itself defines in the workflow source, not gh-aw's: the agent job's
 * `steps:`/`pre-agent-steps:`/`post-steps:`, the trusted threat-detection steps (e.g. repair.md's
 * repair-scope gate), safe-outputs steps and custom `jobs:`. A failure there is never platform. Pure.
 */
function factoryStepNames(frontmatter) {
    const names = new Set();
    const add = (list) => {
        for (const s of Array.isArray(list) ? list : []) if (s && s.name) names.add(s.name);
    };
    const fm = frontmatter || {};
    for (const key of ["steps", "pre-agent-steps", "post-steps"]) add(fm[key]);
    const so = fm["safe-outputs"] || {};
    add(so.steps);
    const td = so["threat-detection"];
    if (td && typeof td === "object") for (const key of ["steps", "pre-steps", "post-steps"]) add(td[key]);
    for (const job of Object.values(fm.jobs || {})) if (job && typeof job === "object") add(job.steps);
    return names;
}

/**
 * The workflow source's frontmatter (between the first two `---` lines), parsed. Throws when it
 * can't be read (fail closed): an empty step set would count the factory's own steps as gh-aw's.
 */
function frontmatterOf(md) {
    const m = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(String(md).replace(/\r\n?/g, "\n"));
    if (!m) throw new Error("no frontmatter block");
    const fm = require("yaml").parse(m[1]);
    if (!fm || typeof fm !== "object" || Array.isArray(fm)) throw new Error("frontmatter is not a mapping");
    return fm;
}

const firstFailedStep = (job) => (job.steps || []).find((s) => s.conclusion === "failure");
const usefulMessage = (msgs) => (msgs || []).find((m) => m && !/^Process completed with exit code/.test(m)) || null;
const clip = (s, n = 200) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Where a failed gh-aw run stopped, and whose failure that is. Pure.
 *   jobs: Actions jobs API ({name, conclusion, steps: [{name, number, conclusion}]})
 *   annotations: {jobName: [message] | null} for the failed jobs (null: unreadable)
 *   factorySteps: the workflow's own step names (factoryStepNames)
 * → {class: platform|factory|policy|agent|verdict|unclear, kind, job, step, message}
 */
function classifyRun(jobs, annotations, factorySteps) {
    const failed = (jobs || []).filter((j) => j.conclusion === "failure");
    const byName = (n) => failed.find((j) => j.name === n);
    const out = (cls, kind, job, step) => ({ class: cls, kind, job: job ? job.name : null, step: step || null, message: job ? clip(usefulMessage(annotations[job.name] || [])) : null });
    const policyStep = (s) => /kill switch|budget gate/i.test(s);

    const agent = byName("agent");
    if (agent) {
        const step = firstFailedStep(agent);
        const name = step && step.name;
        if (name && factorySteps.has(name)) return out(policyStep(name) ? "policy" : "factory", `factory_step:${slug(name)}`, agent, name);
        const exec = (agent.steps || []).find((s) => /^Execute .*CLI$/.test(s.name));
        if (!step) return out("unclear", "agent_job_failed", agent, null);
        if (exec && step.name === exec.name) return out("unclear", "agent_execution_failed", agent, name);
        // Failed before the agent ran (its execution step was skipped or comes later): gh-aw setup.
        if (!exec || exec.conclusion === "skipped" || step.number < exec.number) return out("platform", kindOf("agent_setup", name), agent, name);
        return out("platform", kindOf("agent_post", name), agent, name);
    }
    const detection = byName("detection");
    if (detection) {
        const step = firstFailedStep(detection);
        const name = step && step.name;
        // A trusted gate the factory runs in the detection job (e.g. repair scope): the factory's verdict.
        if (name && factorySteps.has(name)) return out(policyStep(name) ? "policy" : "factory", `factory_step:${slug(name)}`, detection, name);
        // Without its annotations a flagged run and an engine failure look the same: don't guess.
        if (!annotations.detection) return out("unclear", "detection_unreadable", detection, name);
        const msg = usefulMessage(annotations.detection) || "";
        // The engine produced no verdict at all: gh-aw's threat-detect start-up, not a flagged run.
        if (/ERR_SYSTEM|result file not found/i.test(msg)) return out("platform", "detection_no_result", detection, name);
        if (name && name !== "Conclude threat detection") return out("platform", kindOf("detection_setup", name), detection, name);
        return out("verdict", "threat_flagged", detection, name);
    }
    for (const j of failed) {
        if (j.name === "conclusion") continue;
        const step = firstFailedStep(j);
        const name = step && step.name;
        if (name && factorySteps.has(name)) return out(policyStep(name) ? "policy" : "factory", `factory_step:${slug(name)}`, j, name);
        return out("unclear", kindOf(slug(j.name), name), j, name);
    }
    // Only gh-aw's conclusion job failed: the agent ran, then reported it couldn't finish.
    if (byName("conclusion")) return out("agent_reported", "agent_reported_failure", byName("conclusion"), firstFailedStep(byName("conclusion"))?.name);
    return out("unclear", "no_failed_job", null, null);
}

/** The pre-triage verdict in a triage-workflow comment, or null. Only the class and confidence are kept. Pure. */
function triageVerdict(comment, repo) {
    if (!comment || !comment.user || comment.user.login !== TRIAGE_BOT) return null;
    const body = String(comment.body || "");
    if (!body.startsWith("**Pre-triage**") || !body.includes(`<!-- gh-aw-workflow-call-id: ${repo}/triage -->`)) return null;
    const cls = /\*\*Likely cause:\*\*\s*`([a-z-]+)`/.exec(body);
    if (!cls || !TRIAGE_CLASSES.has(cls[1])) return null;
    const conf = /\*\*Confidence:\*\*\s*(high|medium|low)\b/.exec(body);
    return { class: cls[1], confidence: conf ? conf[1] : null, url: comment.html_url, at: comment.created_at };
}

/** One attribution per needs-human event, with its basis (strongest signal first). Pure. */
function attribute({ reason, run, triage, incident }) {
    if (incident) {
        const basis = incident.ref ? `infra incident ${incident.ref} (person-confirmed)` : `label ${INFRA_LABEL} (person; no reason comment recorded)`;
        return { attribution: "factory", basis };
    }
    if (run && ["platform", "factory", "policy"].includes(run.class)) return { attribution: run.class, basis: `run ${run.run_id} stopped at ${run.job}/${run.step || "?"} (${run.kind})` };
    const rc = REASON_CLASS[reason];
    if (rc && rc !== "agent" && rc !== "run") return { attribution: rc, basis: `reason ${reason} is a ${rc === "policy" ? "policy hold" : "factory control"}` };
    if (triage) return { attribution: TRIAGE_ATTRIBUTION[triage.class], basis: `pre-triage: ${triage.class}${triage.confidence ? `, ${triage.confidence} confidence` : ""} (AI, advisory)` };
    if (rc === "agent") return { attribution: "agent", basis: `reason ${reason}; no platform, factory or triage signal` };
    // A failed run whose cause is unknown or unreadable: never counted against the agent.
    if (rc === "run") return { attribution: "unclear", basis: `reason ${reason}; run cause ${run ? `${run.class} (${run.kind})` : "unavailable"}, no triage verdict` };
    return { attribution: "unclear", basis: `reason ${reason || "unknown"}: no signal` };
}

const DISPATCH_MATCH_MINUTES = 30; // spend.ts: a dispatched run is created within 30 minutes

/**
 * The run a needs-human event is about. For `repair_failed` the event's run_id is the failing CI run
 * the repair was for (planner.ts), so the repair run is resolved like the controller does: its latest
 * `repair_dispatched` record for that CI run, then the repair run with that exact title created
 * within DISPATCH_MATCH_MINUTES after it. Null if not found (then the run's cause is unknown). Pure.
 */
function eventRunId(e, dispatches, runs) {
    const p = e.payload;
    if (p.reason !== "repair_failed") return p.run_id ?? null;
    const rec = dispatches
        .filter((d) => d.type === "repair_dispatched" && d.payload.task === p.task && d.payload.run_id === p.run_id && d.timestamp <= e.timestamp)
        .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))[0];
    if (!rec) return null;
    const title = `Repair ${p.task} #${rec.payload.issue} attempt ${rec.payload.attempt}`;
    const t = Date.parse(rec.timestamp);
    const match = [...runs.values()]
        .filter((r) => r.workflow === "repair" && r.title === title && Date.parse(r.created_at) >= t && Date.parse(r.created_at) - t <= DISPATCH_MATCH_MINUTES * 60_000)
        .sort((a, b) => b.run_id - a.run_id)[0];
    return match ? match.run_id : null;
}

/**
 * The window's needs-human events, each attributed. Pure.
 *   events: window audit events; incidentEvents: human_action/infra_incident (any time)
 *   dispatches: repair_dispatched events (window + lookback); labeled: issue numbers labeled INFRA_LABEL
 *   runs: Map run_id → classified failed run; triage: Map issue → [verdict] (from triageVerdict)
 */
function attributeFailures({ events, incidentEvents, dispatches = [], labeled, runs, triage }) {
    const incidents = new Map();
    for (const e of incidentEvents) if (e.payload.issue) incidents.set(e.payload.issue, { ref: e.payload.incident, comment_url: e.payload.comment_url, labeled_at: e.payload.labeled_at });
    const handoffs = events.filter((e) => e.type === "needs_human");
    return handoffs.map((e) => {
        const p = e.payload;
        const runId = eventRunId(e, dispatches, runs);
        const run = runId ? runs.get(runId) || null : null;
        // This hand-off's verdict: after it, and before the issue's next hand-off (a later attempt's).
        const next = handoffs.filter((x) => x.payload.issue === p.issue && x.timestamp > e.timestamp).map((x) => x.timestamp).sort()[0];
        const verdicts = (triage.get(p.issue) || []).filter((v) => v.at >= e.timestamp && (!next || v.at < next)).sort((a, b) => (a.at < b.at ? 1 : -1));
        const incident = incidents.get(p.issue) || (labeled.has(p.issue) ? { ref: null } : null);
        const t = verdicts[0] || null;
        return {
            at: e.timestamp,
            issue: p.issue ?? null,
            task: p.task ?? null,
            reason: p.reason,
            run_id: runId,
            ...(runId !== (p.run_id ?? null) ? { ci_run_id: p.run_id ?? null } : {}),
            run: run ? { class: run.class, kind: run.kind, job: run.job, step: run.step, url: run.url } : null,
            triage: t,
            infra_incident: incident,
            ...attribute({ reason: p.reason, run, triage: t, incident }),
        };
    });
}

/** Platform failures by kind, with run links; a kind seen RECUR_AT+ times is flagged. Pure. */
function platformReliability(failedRuns, window) {
    const kinds = {};
    for (const r of failedRuns.filter((x) => x.class === "platform")) (kinds[r.kind] ||= []).push(r);
    const platform = Object.entries(kinds)
        .map(([kind, rs]) => ({ kind, count: rs.length, recurring: rs.length >= RECUR_AT, runs: rs.map((r) => ({ workflow: r.workflow, run_id: r.run_id, url: r.url, at: r.created_at, job: r.job, step: r.step, message: r.message })) }))
        .sort((a, b) => b.count - a.count || (a.kind < b.kind ? -1 : 1));
    const byClass = {};
    for (const r of failedRuns) byClass[r.class] = (byClass[r.class] || 0) + 1;
    return {
        schema: 1,
        window,
        recur_at: RECUR_AT,
        failed_runs: failedRuns.length,
        by_class: byClass,
        platform_failures: platform.reduce((a, k) => a + k.count, 0),
        platform,
        recurring: platform.filter((k) => k.recurring).map((k) => k.kind),
        runs: failedRuns.map((r) => ({ workflow: r.workflow, run_id: r.run_id, url: r.url, at: r.created_at, class: r.class, kind: r.kind, job: r.job, step: r.step, message: r.message })),
    };
}

const cell = (s) => String(s ?? "").replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ");

/** The summary.md sections for failures and platform reliability. Pure. */
function failuresMd(failures, reliability) {
    const lines = ["", "## Failures, attributed (needs-human in the window; plain code, strongest signal first)", ""];
    lines.push("Attribution: `agent` (the agent's work), `factory` (this factory's code, config or controls), `platform` (gh-aw / GitHub Actions), `policy` (a deliberate stop), `factory_or_platform` (not the agent; which one is unconfirmed), `unclear`.", "");
    if (failures.length === 0) lines.push("- none");
    else {
        lines.push("| issue | task | reason | run stopped at | pre-triage | infra incident | attribution | basis |", "|---|---|---|---|---|---|---|---|");
        for (const f of failures) {
            const run = f.run ? `[${f.run_id}](${f.run.url}) ${f.run.kind}` : f.run_id ? `${f.run_id} (not a failed gh-aw run)` : "";
            const tri = f.triage ? `\`${f.triage.class}\` (${f.triage.confidence || "?"})` : "none";
            const inc = f.infra_incident ? f.infra_incident.ref || "label only" : "";
            lines.push(`| #${f.issue} | ${cell(f.task)} | ${f.reason} | ${cell(run)} | ${tri} | ${cell(inc)} | **${f.attribution}** | ${cell(f.basis)} |`);
        }
        const tally = {};
        for (const f of failures) tally[f.attribution] = (tally[f.attribution] || 0) + 1;
        lines.push("", `- by attribution: ${JSON.stringify(tally)}`);
    }
    lines.push("", `## Platform reliability (gh-aw / GitHub Actions; failed runs of every gh-aw workflow in the window)`, "");
    lines.push(`- failed gh-aw runs: ${reliability.failed_runs}; by class: ${JSON.stringify(reliability.by_class)}`);
    if (reliability.platform.length === 0) lines.push("- platform failures: none");
    else {
        lines.push("", "| kind | count | recurring (≥ " + reliability.recur_at + ") | runs |", "|---|---|---|---|");
        for (const k of reliability.platform) lines.push(`| ${k.kind} | ${k.count} | ${k.recurring ? "**yes**: report upstream to github/gh-aw" : "no"} | ${k.runs.map((r) => `[${r.run_id}](${r.url}) (${r.workflow})`).join(", ")} |`);
    }
    const other = reliability.runs.filter((r) => r.class !== "platform");
    if (other.length) {
        lines.push("", "Other failed gh-aw runs:", "", "| workflow | run | class | kind | message |", "|---|---|---|---|---|");
        for (const r of other) lines.push(`| ${r.workflow} | [${r.run_id}](${r.url}) | ${r.class} | ${cell(r.kind)} | ${cell(r.message)} |`);
    }
    return lines.join("\n") + "\n";
}

/**
 * Network part (read-only GitHub API, `gh` from gather.js): every failed run of the gh-aw workflows
 * since `since`, classified; the needs-human issues' pre-triage verdicts; the infra-incident label.
 * Bounded: at most `maxRuns` runs (newest first) and one comment page per issue.
 */
/** A run whose title names a `drill/` task (`Implement drill/x #1 attempt 1`, `Review drill/x PR #1`). */
const isDrillRun = (title) => /^(?:Implement|Repair|Review|Triage) drill\//.test(title || "");

async function fetchFailureData({ gh, repo, since, workflows, events, maxRuns = 60 }) {
    const day = since.slice(0, 10);
    const failed = [];
    for (const { name, file, factorySteps } of workflows) {
        let list;
        try {
            list = await gh(`/repos/${repo}/actions/workflows/${file}/runs?status=failure&created=%3E%3D${day}&per_page=100`);
        } catch (e) {
            console.log(`::warning::${name} runs unreadable (${e.message}): its failures are missing from the data`);
            continue;
        }
        // Runs for a `drill/` task (the agentic canary, harness/drills/canary.js) fail on purpose.
        for (const r of list.workflow_runs || []) if (r.created_at >= since && !isDrillRun(r.display_title)) failed.push({ workflow: name, run_id: r.id, url: r.html_url, title: r.display_title, created_at: r.created_at, factorySteps });
    }
    failed.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    if (failed.length > maxRuns) console.log(`::warning::${failed.length} failed runs; classifying the newest ${maxRuns}`);
    const runs = [];
    for (const r of failed.slice(0, maxRuns)) {
        let c;
        try {
            const jobs = (await gh(`/repos/${repo}/actions/runs/${r.run_id}/jobs?per_page=100`)).jobs || [];
            const annotations = {};
            for (const j of jobs.filter((x) => x.conclusion === "failure")) {
                try {
                    annotations[j.name] = (await gh(`/repos/${repo}/check-runs/${j.id}/annotations?per_page=20`)).filter((a) => a.annotation_level === "failure").map((a) => a.message);
                } catch {
                    annotations[j.name] = null;
                }
            }
            c = classifyRun(jobs, annotations, r.factorySteps);
        } catch (e) {
            c = { class: "unclear", kind: "jobs_unreadable", job: null, step: null, message: clip(e.message) };
        }
        runs.push({ workflow: r.workflow, run_id: r.run_id, url: r.url, title: r.title, created_at: r.created_at, ...c });
    }

    const triage = new Map();
    const issues = [...new Set(events.filter((e) => e.type === "needs_human" && e.payload.issue).map((e) => e.payload.issue))];
    for (const n of issues) {
        try {
            const comments = await gh(`/repos/${repo}/issues/${n}/comments?per_page=100&since=${encodeURIComponent(since)}`);
            triage.set(n, comments.map((c) => triageVerdict(c, repo)).filter(Boolean));
        } catch {
            triage.set(n, []);
        }
    }
    let labeled = new Set();
    try {
        const items = await gh(`/repos/${repo}/issues?labels=${encodeURIComponent(INFRA_LABEL)}&state=all&per_page=100`);
        labeled = new Set(items.filter((i) => !i.pull_request).map((i) => i.number));
    } catch (e) {
        console.log(`::warning::${INFRA_LABEL} issues unreadable (${e.message})`);
    }
    return { runs, triage, labeled };
}

module.exports = { isDrillRun, REASON_CLASS, RECUR_AT, factoryStepNames, eventRunId, frontmatterOf, classifyRun, triageVerdict, attribute, attributeFailures, platformReliability, failuresMd, fetchFailureData };
