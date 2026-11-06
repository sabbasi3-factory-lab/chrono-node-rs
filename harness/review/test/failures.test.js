"use strict";
const test = require("node:test");
const assert = require("node:assert");
const f = require("../failures");

const REPO = "o/r";
const step = (number, name, conclusion = "success") => ({ number, name, conclusion });
const AGENT_STEPS = (failAt) => [step(1, "Set up job"), step(2, "Validate dispatch and contract freshness", failAt === "factory" ? "failure" : "success"), step(3, "Start MCP Gateway", failAt === "gateway" ? "failure" : failAt === "factory" ? "skipped" : "success"), step(4, "Execute GitHub Copilot CLI", failAt === "exec" ? "failure" : failAt === "gateway" || failAt === "factory" ? "skipped" : "success")];
const job = (name, conclusion, steps = []) => ({ name, conclusion, steps });
const FACTORY = new Set(["Validate dispatch and contract freshness", "Kill switch"]);

test("classifyRun: where a failed gh-aw run stopped (live shapes, 2026-11-05)", () => {
    const c = (jobs, ann = {}) => f.classifyRun(jobs, ann, FACTORY);
    // 42053301543: agent job failed at Start MCP Gateway, before the agent ran.
    assert.deepStrictEqual(pick(c([job("agent", "failure", AGENT_STEPS("gateway")), job("conclusion", "failure", [step(1, "Handle agent failure", "failure")])])), ["platform", "mcp_gateway_start", "Start MCP Gateway"]);
    // 42057503725: the agent succeeded; threat detection produced no result file.
    const det = job("detection", "failure", [step(1, "Execute threat detection with AWF"), step(2, "Conclude threat detection", "failure")]);
    assert.deepStrictEqual(pick(c([job("agent", "success"), det], { detection: ["Process completed with exit code 1.", "ERR_SYSTEM: ❌ Detection result file not found at: /tmp/gh-aw/threat-detection/detection_result.json"] })), ["platform", "detection_no_result", "Conclude threat detection"]);
    // A real verdict is not a platform failure.
    assert.deepStrictEqual(pick(c([det], { detection: ["Threat detected: prompt injection"] })), ["verdict", "threat_flagged", "Conclude threat detection"]);
    assert.deepStrictEqual(pick(c([det], { detection: null })), ["unclear", "detection_unreadable", "Conclude threat detection"], "annotations unreadable: no guess");
    assert.deepStrictEqual(pick(c([job("detection", "failure", [step(1, "Install threat-detect binary", "failure")])], { detection: [] })), ["platform", "detection_setup:install_threat_detect_binary", "Install threat-detect binary"]);
    // 41906107478: only the conclusion job failed: the agent reported it couldn't finish.
    assert.deepStrictEqual(pick(c([job("agent", "success"), job("conclusion", "failure", [step(1, "Handle agent failure", "failure")])])), ["agent_reported", "agent_reported_failure", "Handle agent failure"]);
    // 41662949515: a factory-owned step (the workflow's own `steps:`), never counted as gh-aw's.
    assert.deepStrictEqual(pick(c([job("agent", "failure", AGENT_STEPS("factory"))])), ["factory", "factory_step:validate_dispatch_and_contract_freshness", "Validate dispatch and contract freshness"]);
    assert.strictEqual(c([job("agent", "failure", [step(1, "Kill switch", "failure")])]).class, "policy");
    // The agent's own execution failing: engine or agent, so unclear (triage decides).
    assert.deepStrictEqual(pick(c([job("agent", "failure", AGENT_STEPS("exec"))])), ["unclear", "agent_execution_failed", "Execute GitHub Copilot CLI"]);
    assert.deepStrictEqual(pick(c([job("safe_outputs", "failure", [step(1, "Process Safe Outputs", "failure")])], { safe_outputs: ["Claim deliveries unverified"] })), ["unclear", "safe_outputs:process_safe_outputs", "Process Safe Outputs"]);
});
const pick = (r) => [r.class, r.kind, r.step];

test("factoryStepNames: the workflow source's own steps", () => {
    const fm = f.frontmatterOf("---\non: push\nsteps:\n  - name: Kill switch\n    run: x\npost-steps:\n  - name: After\n    run: y\n---\n# body\n");
    assert.deepStrictEqual([...f.factoryStepNames(fm)], ["Kill switch", "After"]);
    assert.deepStrictEqual([...f.factoryStepNames({})], []);
});

test("triageVerdict: only the triage workflow's comment, only an allowed class", () => {
    const marker = `\n<!-- gh-aw-workflow-call-id: ${REPO}/triage -->`;
    const body = "**Pre-triage** (AI, advisory · reason `implement_failed` · signature `none`)\n**Likely cause:** `flaky-or-infra`: gateway\n**Confidence:** high" + marker;
    const cm = (login, b) => ({ user: { login }, body: b, html_url: "u", created_at: "2026-11-05T15:42:24Z" });
    assert.deepStrictEqual(f.triageVerdict(cm("github-actions[bot]", body), REPO), { class: "flaky-or-infra", confidence: "high", url: "u", at: "2026-11-05T15:42:24Z" });
    assert.strictEqual(f.triageVerdict(cm("someone", body), REPO), null, "not the workflow's identity");
    assert.strictEqual(f.triageVerdict(cm("github-actions[bot]", body.replace(marker, "")), REPO), null, "no triage marker");
    assert.strictEqual(f.triageVerdict(cm("github-actions[bot]", body.replace("flaky-or-infra", "agent-is-fine")), REPO), null, "unknown class");
});

test("attribute: person's infra incident > where the run stopped > factory reason > pre-triage > agent", () => {
    const run = { run_id: 1, class: "platform", kind: "mcp_gateway_start", job: "agent", step: "Start MCP Gateway" };
    const tri = { class: "port-bug", confidence: "low" };
    assert.strictEqual(f.attribute({ reason: "implement_failed", run, triage: tri, incident: { ref: "#303" } }).attribution, "factory");
    assert.strictEqual(f.attribute({ reason: "implement_failed", run, triage: tri }).attribution, "platform");
    assert.strictEqual(f.attribute({ reason: "missing_heldout_seed" }).attribution, "factory");
    assert.strictEqual(f.attribute({ reason: "task_budget_exhausted" }).attribution, "policy");
    assert.strictEqual(f.attribute({ reason: "implement_failed", run: { ...run, class: "agent_reported" }, triage: { class: "flaky-or-infra" } }).attribution, "factory_or_platform");
    assert.strictEqual(f.attribute({ reason: "implement_failed", triage: tri }).attribution, "agent");
    assert.strictEqual(f.attribute({ reason: "review_objected" }).attribution, "agent");
    assert.strictEqual(f.attribute({ reason: "something_new" }).attribution, "unclear");
});

test("attributeFailures: joins needs-human events with runs, verdicts after the event, incidents and the label", () => {
    const ev = (type, ts, payload) => ({ type, timestamp: ts, payload: { dry_run: false, ...payload } });
    const events = [
        ev("needs_human", "2026-11-04T20:31:06Z", { issue: 291, task: "fi/a", reason: "implement_failed", run_id: 11 }),
        ev("needs_human", "2026-11-05T15:32:43Z", { issue: 327, task: "id/b", reason: "implement_failed", run_id: 12 }),
        ev("needs_human", "2026-11-05T16:00:00Z", { issue: 400, task: "id/c", reason: "implement_failed", run_id: 13 }),
        ev("merged", "2026-11-05T16:00:00Z", { task: "x" }),
    ];
    const incidentEvents = [ev("human_action", "2026-11-05T17:43:28Z", { action: "infra_incident", issue: 291, incident: "#303", comment_url: "c", labeled_at: "2026-11-05T17:42:37Z" })];
    const runs = new Map([[12, { run_id: 12, class: "platform", kind: "mcp_gateway_start", job: "agent", step: "Start MCP Gateway", url: "r12" }]]);
    const triage = new Map([[400, [{ class: "port-bug", confidence: "high", at: "2026-11-05T15:00:00Z" }, { class: "shared-infra-gap", confidence: "medium", at: "2026-11-05T16:10:00Z" }]]]);
    const out = f.attributeFailures({ events, incidentEvents, labeled: new Set([291]), runs, triage });
    assert.deepStrictEqual(out.map((x) => [x.issue, x.attribution]), [[291, "factory"], [327, "platform"], [400, "factory"]]);
    assert.strictEqual(out[2].triage.class, "shared-infra-gap", "the verdict before the event is an older attempt's");
    assert.deepStrictEqual(f.attributeFailures({ events: events.slice(0, 1), incidentEvents: [], labeled: new Set([291]), runs, triage }).map((x) => x.basis), [`label factory:infra-incident (person; no reason comment recorded)`]);
});

test("platformReliability: platform failures by kind, flagged at 2+, and the summary tables", () => {
    const r = (id, cls, kind) => ({ workflow: "implement", run_id: id, url: `u${id}`, created_at: "2026-11-05T00:00:00Z", class: cls, kind, job: "agent", step: "s", message: null });
    const rel = f.platformReliability([r(1, "platform", "mcp_gateway_start"), r(2, "platform", "mcp_gateway_start"), r(3, "platform", "detection_no_result"), r(4, "agent_reported", "agent_reported_failure")], { from: "a", to: "b" });
    assert.deepStrictEqual([rel.failed_runs, rel.platform_failures, rel.recurring, rel.by_class], [4, 3, ["mcp_gateway_start"], { platform: 3, agent_reported: 1 }]);
    assert.deepStrictEqual(rel.platform.map((k) => [k.kind, k.count, k.recurring]), [["mcp_gateway_start", 2, true], ["detection_no_result", 1, false]]);
    const md = f.failuresMd([], rel);
    assert.match(md, /\| mcp_gateway_start \| 2 \| \*\*yes\*\*: report upstream to github\/gh-aw \| \[1\]\(u1\) \(implement\), \[2\]\(u2\) \(implement\) \|/);
    assert.match(md, /\| implement \| \[4\]\(u4\) \| agent_reported \| agent_reported_failure \|/);
    assert.match(f.failuresMd([], f.platformReliability([], {})), /platform failures: none/);
});

test("failuresMd: table cells escape backslashes before pipes", () => {
    const md = f.failuresMd([{ issue: 1, task: "a\\|b", reason: "r", run_id: null, run: null, triage: null, infra_incident: null, attribution: "unclear", basis: "x" }], f.platformReliability([], {}));
    assert.match(md, /\| a\\\\\\\|b \|/);
});

test("review #349: frontmatter fails closed; CRLF reads the same", () => {
    assert.throws(() => f.frontmatterOf("# no frontmatter\n"), /no frontmatter/);
    assert.throws(() => f.frontmatterOf("---\n- a\n---\n"), /not a mapping/);
    assert.throws(() => f.frontmatterOf("---\nsteps: [\n---\n"));
    const crlf = "---\r\nsteps:\r\n  - name: Kill switch\r\n    run: x\r\n---\r\n# body\r\n";
    assert.deepStrictEqual([...f.factoryStepNames(f.frontmatterOf(crlf))], ["Kill switch"]);
});

test("review #349: source-defined threat-detection steps are factory steps, before the platform rules", () => {
    const fm = { steps: [{ name: "A" }], "safe-outputs": { "threat-detection": { steps: [{ name: "Repair scope (trusted) - the patch may change only the contract's scope files" }] }, steps: [{ name: "S" }] }, jobs: { extra: { steps: [{ name: "J" }] } } };
    const names = f.factoryStepNames(fm);
    assert.deepStrictEqual([...names].sort(), ["A", "J", "Repair scope (trusted) - the patch may change only the contract's scope files", "S"]);
    const gate = "Repair scope (trusted) - the patch may change only the contract's scope files";
    const det = job("detection", "failure", [step(1, gate, "failure"), step(2, "Conclude threat detection", "failure")]);
    // Even with the no-result message (the gate stopped the job before a result), it's the factory's gate.
    const r = f.classifyRun([det], { detection: ["ERR_SYSTEM: ❌ Detection result file not found"] }, names);
    assert.deepStrictEqual([r.class, r.kind], ["factory", "factory_step:repair_scope_trusted_the_patch_may_change_only_the_contract_s_scope_files"]);
});

test("review #349: implement_failed / repair_failed / review_timeout with no resolving signal stay unclear", () => {
    for (const reason of ["implement_failed", "repair_failed", "review_timeout"]) {
        assert.strictEqual(f.attribute({ reason }).attribution, "unclear", reason);
        assert.strictEqual(f.attribute({ reason, run: { run_id: 1, class: "unclear", kind: "agent_execution_failed" } }).attribution, "unclear", reason);
        assert.strictEqual(f.attribute({ reason, run: { run_id: 1, class: "agent_reported", kind: "agent_reported_failure" } }).attribution, "unclear", reason);
    }
    assert.match(f.attribute({ reason: "implement_failed" }).basis, /run cause unavailable, no triage verdict/);
    assert.strictEqual(f.attribute({ reason: "implement_failed", triage: { class: "port-bug" } }).attribution, "agent");
});

test("review #349: repair_failed joins the repair run (resolved from its repair_dispatched record), not the CI run", () => {
    const ev = (type, ts, payload) => ({ type, timestamp: ts, payload: { dry_run: false, ...payload } });
    const nh = ev("needs_human", "2026-11-05T12:00:00Z", { issue: 7, task: "en/a", reason: "repair_failed", run_id: 500 });
    const dispatches = [
        ev("repair_dispatched", "2026-11-05T10:00:00Z", { task: "en/a", issue: 7, attempt: 2, run_id: 500 }),
        ev("repair_dispatched", "2026-11-05T09:00:00Z", { task: "en/a", issue: 7, attempt: 2, run_id: 499 }),
        ev("repair_dispatched", "2026-11-05T13:00:00Z", { task: "en/a", issue: 7, attempt: 3, run_id: 500 }),
    ];
    const r = (id, title, at, extra = {}) => [id, { workflow: "repair", run_id: id, title, created_at: at, url: `u${id}`, class: "platform", kind: "mcp_gateway_start", job: "agent", step: "Start MCP Gateway", ...extra }];
    const runs = new Map([
        r(900, "Repair en/a #7 attempt 2", "2026-11-05T10:05:00Z"),
        r(901, "Repair en/a #7 attempt 2", "2026-11-05T11:00:00Z"), // too late after the dispatch
        r(902, "Repair en/b #7 attempt 2", "2026-11-05T10:05:00Z"),
        [500, { workflow: "ci", run_id: 500, class: "factory", kind: "x" }],
    ]);
    assert.strictEqual(f.eventRunId(nh, dispatches, runs), 900);
    const [a] = f.attributeFailures({ events: [nh], incidentEvents: [], dispatches, labeled: new Set(), runs, triage: new Map() });
    assert.deepStrictEqual([a.run_id, a.ci_run_id, a.run.url, a.attribution], [900, 500, "u900", "platform"]);
    // No matching repair run: unknown cause, never the CI run's.
    const [b] = f.attributeFailures({ events: [nh], incidentEvents: [], dispatches: dispatches.slice(1), labeled: new Set(), runs, triage: new Map() });
    assert.deepStrictEqual([b.run_id, b.run, b.attribution], [null, null, "unclear"]);
    // implement_failed keeps its own run id.
    assert.strictEqual(f.eventRunId(ev("needs_human", "2026-11-05T12:00:00Z", { reason: "implement_failed", run_id: 42 }), dispatches, runs), 42);
});

test("review #349: each hand-off gets the triage verdict between it and the issue's next hand-off", () => {
    const ev = (type, ts, payload) => ({ type, timestamp: ts, payload: { dry_run: false, ...payload } });
    const events = [
        ev("needs_human", "2026-11-04T10:00:00Z", { issue: 9, task: "en/a", reason: "implement_failed", run_id: 1 }),
        ev("needs_human", "2026-11-05T10:00:00Z", { issue: 9, task: "en/a", reason: "implement_failed", run_id: 2 }),
    ];
    const triage = new Map([[9, [{ class: "port-bug", confidence: "high", at: "2026-11-04T10:20:00Z" }, { class: "shared-infra-gap", confidence: "high", at: "2026-11-05T10:20:00Z" }]]]);
    const out = f.attributeFailures({ events, incidentEvents: [], labeled: new Set(), runs: new Map(), triage });
    assert.deepStrictEqual(out.map((x) => [x.triage.class, x.attribution]), [["port-bug", "agent"], ["shared-infra-gap", "factory"]]);
});

test("isDrillRun: the agentic canary's runs (drill/ tasks) are not failures to attribute", () => {
    const { WORKFLOWS } = require("../../drills/canary");
    for (const w of Object.values(WORKFLOWS)) assert.strictEqual(f.isDrillRun(w.title), true, w.title);
    for (const t of ["Implement ru/weekday-parser #393 attempt 1", "Review ru/x PR #408", "Factory review", "", null]) assert.strictEqual(f.isDrillRun(t), false, String(t));
});
