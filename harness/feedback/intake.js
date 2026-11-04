#!/usr/bin/env node
"use strict";
// Bug intake (DESIGN §6 "new work while running"). Plain code, no AI: a bug report is a request
// that can be re-run through both implementations, so triage is deterministic.
//
//   node feedback/intake.js authorize --event EVENT.json            does the labeller have write access (needs a token with push access)
//   node feedback/intake.js input  --event EVENT.json --out DIR --authorized true|false   the request
//   node feedback/intake.js decide --issue N --out DIR             after compare.js --requests: propose or report
//   node feedback/intake.js comment --issue N --out DIR [--pr M]   (live) comment, label, close
//   node feedback/intake.js pending                                fix ids on main without a task issue
//   node feedback/intake.js tasks --plan PLAN.json                 (live) create those task issues (seed.js issues --plan output)
//   node feedback/intake.js link                                   (live) after a fix PR merges: link bug → task
//
// See README.md for the whole flow. Writes go through the controller App token, only in the
// workflow's live jobs; `input` and `decide` use a read-only token. The write commands load no
// third-party module (only this directory and Node built-ins), and check everything they read
// from the triage job's artifact.
const fs = require("fs");
const path = require("path");
const lib = require("./lib");
const { REPO, gh, openIssues, paginate } = require("./github");

const HARNESS = path.resolve(__dirname, "..");
const FIX_INPUTS = path.join(HARNESS, "golden/fixes");
const CONTROLLER_BOT = lib.FACTORY_BOT;
const WRITERS = new Set(["admin", "maintain", "write"]);

const opt = (name) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : null;
};
const writeJson = (file, v) => fs.writeFileSync(file, JSON.stringify(v, null, 2) + "\n");
const slug = (id) => id.replace("/", "-");

/** Who asked for triage: the issue's author when it was opened, the labeller when labelled later. */
async function authorized(event) {
    const login = event.action === "labeled" ? event.sender && event.sender.login : event.issue.user && event.issue.user.login;
    if (!login) return { ok: false, login: null };
    // The monitor files as the controller App; its bot account isn't a collaborator.
    if (login === CONTROLLER_BOT) return { ok: true, login };
    const p = await gh("GET", `/repos/${REPO}/collaborators/${encodeURIComponent(login)}/permission`);
    return { ok: Boolean(p && WRITERS.has(p.permission)), login };
}

async function input() {
    const out = opt("--out");
    const event = JSON.parse(fs.readFileSync(opt("--event"), "utf8"));
    fs.mkdirSync(out, { recursive: true });
    const issue = event.issue;
    const labels = (issue.labels || []).map((l) => l.name);
    if (!labels.includes("factory:bug") || (event.action === "labeled" && event.label.name !== "factory:bug")) {
        return writeJson(path.join(out, "decision.json"), { action: "ignore", reason: "not_factory_bug" });
    }
    if (opt("--authorized") !== "true") {
        console.log("ignored: the labeller doesn't have write access (a maintainer can re-add factory:bug)");
        return writeJson(path.join(out, "decision.json"), { action: "ignore", reason: "not_authorized" });
    }
    const parsed = lib.parseReport(issue.body || "");
    // Only the named configurations the golden data and the harness know (tests/golden/configurations.json).
    const known = Object.keys(JSON.parse(fs.readFileSync(path.join(HARNESS, "../tests/golden/configurations.json"), "utf8")).configurations);
    if (!parsed.error && !known.includes(parsed.request.config)) parsed.error = lib.ERRORS.config;
    if (parsed.error) return writeJson(path.join(out, "decision.json"), { action: "report", reason: "invalid", detail: parsed.error });
    fs.writeFileSync(path.join(out, "request.jsonl"), JSON.stringify(parsed.request) + "\n");
    console.log(`#${issue.number}: ${parsed.request.config} request ready for triage`);
}

/** Prints and outputs `authorized=true|false` for the labeller. The permission API needs push access. */
async function authorize() {
    const who = await authorized(JSON.parse(fs.readFileSync(opt("--event"), "utf8")));
    console.log(`${who.login}: ${who.ok ? "write access" : "no write access"}`);
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `authorized=${who.ok}\n`);
}

async function decide() {
    const out = opt("--out");
    const issue = Number(opt("--issue"));
    let outcome;
    try {
        outcome = (JSON.parse(fs.readFileSync(path.join(out, "report.json"), "utf8")).requests || [])[0];
    } catch {
        outcome = undefined; // compare.js crashed before writing its report: a person looks
    }
    const d = lib.decide(outcome);
    if (d.action !== "propose") return writeJson(path.join(out, "decision.json"), { ...d, detail: outcome || null });
    const request = JSON.parse(fs.readFileSync(path.join(out, "request.jsonl"), "utf8"));
    const fix = lib.fixId(request);
    const file = path.join(FIX_INPUTS, `${slug(fix)}.json`);
    if (fs.existsSync(file)) return writeJson(path.join(out, "decision.json"), { action: "report", reason: "duplicate", detail: { fix, where: "on main" } });
    if (process.env.GH_TOKEN && (await gh("GET", `/repos/${REPO}/branches/${encodeURIComponent(`factory/intake/${slug(fix)}`)}`))) {
        return writeJson(path.join(out, "decision.json"), { action: "report", reason: "duplicate", detail: { fix, where: "fix PR open" } });
    }
    const sig = lib.signature({ request, requires: outcome.requires });
    fs.mkdirSync(FIX_INPUTS, { recursive: true });
    writeJson(file, { id: fix, issue, signature: sig, request: { ...lib.canonicalRequest(request), system_timezone: "UTC" } });
    writeJson(path.join(out, "decision.json"), { action: "propose", reason: "mismatch", fix, signature: sig, branch: `factory/intake/${slug(fix)}` });
    console.log(`#${issue}: port bug confirmed; proposing ${fix}`);
}

async function comment() {
    const out = opt("--out");
    const issue = Number(opt("--issue"));
    const pr = opt("--pr");
    // The decision comes from the triage job's artifact (that job ran third-party and agent-written
    // code), so only known reasons and validated details are used.
    const d = lib.checkDecision(JSON.parse(fs.readFileSync(path.join(out, "decision.json"), "utf8")));
    if (d.action === "ignore") return;
    const reason = d.action === "propose" ? "proposed" : d.reason;
    const detail = d.action === "propose" ? { fix: d.fix, pr: Number(pr) } : d.detail;
    if (d.action === "propose" && !/^[1-9]\d*$/.test(pr || "")) throw new Error("--pr is required for a proposal");
    await gh("POST", `/repos/${REPO}/issues/${issue}/comments`, { body: lib.reportComment(reason, detail) });
    if (d.action === "propose") {
        await gh("POST", `/repos/${REPO}/issues/${issue}/labels`, { labels: ["intake:proposed"] });
    } else if (reason === "same_as_chrono_node") {
        // The report says chrono-node's own output is wrong: never automatic, the owner decides.
        await gh("POST", `/repos/${REPO}/issues/${issue}/labels`, { labels: ["intake:not-a-port-bug", "needs-human"] });
    } else if (reason === "not_yet_ported") {
        await gh("POST", `/repos/${REPO}/issues/${issue}/labels`, { labels: ["intake:not-ported-yet"] });
        await gh("PATCH", `/repos/${REPO}/issues/${issue}`, { state: "closed", state_reason: "not_planned" });
    } else if (reason === "error" || reason === "no_upstream_result") {
        await gh("POST", `/repos/${REPO}/issues/${issue}/labels`, { labels: ["needs-human"] });
    }
}

/** After a fix contract merges (its task issue now exists): point the open bug report at the task and close it. */
async function link() {
    const fixes = fs.existsSync(FIX_INPUTS) ? fs.readdirSync(FIX_INPUTS).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(FIX_INPUTS, f), "utf8"))) : [];
    const tasks = new Map();
    for (const i of await paginate(`/repos/${REPO}/issues?labels=factory:task&state=all`)) {
        const m = /<!-- factory-task: ([a-z0-9/-]+) -->/.exec(i.body || "");
        if (m && !i.pull_request) tasks.set(m[1], i.number);
    }
    const open = new Set((await openIssues()).map((i) => i.number));
    for (const f of fixes) {
        const task = tasks.get(f.id);
        if (!task || !open.has(f.issue) || f.issue === task) continue;
        await gh("POST", `/repos/${REPO}/issues/${f.issue}/comments`, {
            body: `**Factory intake** (plain code, no AI) · tracked as task #${task}\n\nThe fix contract for \`${f.id}\` merged. The factory works on it as task #${task}, which closes when the fix merges.`,
        });
        await gh("PATCH", `/repos/${REPO}/issues/${f.issue}`, { state: "closed", state_reason: "completed" });
        console.log(`#${f.issue} → task #${task}`);
    }
}

/**
 * Create the task issues in a plan from `seed.js issues --plan --only <ids>` (run before the token
 * exists). Fix tasks only: no dependencies, labels created if missing, never an existing marker twice.
 */
async function tasks() {
    const plan = JSON.parse(fs.readFileSync(opt("--plan"), "utf8"));
    const have = new Set();
    for (const i of await paginate(`/repos/${REPO}/issues?labels=factory:task&state=all`)) {
        const m = /<!-- factory-task: ([a-z0-9/-]+) -->/.exec(i.body || "");
        if (m) have.add(m[1]);
    }
    const labels = new Set((await paginate(`/repos/${REPO}/labels`)).map((l) => l.name));
    for (const p of plan) {
        const id = (/^<!-- factory-task: ([a-z]{2}\/fix-[0-9a-f]{8}) -->$/.exec(p.marker) || [])[1];
        if (!id || p.blocked_by.length > 0 || !p.body.startsWith(p.marker)) throw new Error(`not a fix task plan entry: ${String(p.marker).slice(0, 80)}`);
        if (have.has(id)) continue;
        for (const l of p.labels) {
            if (!/^(factory:task|tier:[a-z-]+|area:[a-z0-9-]+)$/.test(l)) throw new Error(`unexpected label ${l}`);
            if (!labels.has(l)) await gh("POST", `/repos/${REPO}/labels`, { name: l, color: "EDEDED" });
            labels.add(l);
        }
        const created = await gh("POST", `/repos/${REPO}/issues`, { title: p.title, body: p.body, labels: p.labels });
        console.log(`created #${created.number} ${id}`);
    }
}

/** Fix ids on main without a task issue yet (input for `seed.js issues --plan --only`). */
async function pending() {
    const ids = fs.existsSync(FIX_INPUTS) ? fs.readdirSync(FIX_INPUTS).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(FIX_INPUTS, f), "utf8")).id) : [];
    const have = new Set();
    for (const i of await paginate(`/repos/${REPO}/issues?labels=factory:task&state=all`)) {
        const m = /<!-- factory-task: ([a-z0-9/-]+) -->/.exec(i.body || "");
        if (m) have.add(m[1]);
    }
    console.log(ids.filter((id) => !have.has(id)).sort().join(","));
}

const commands = { authorize, input, decide, comment, tasks, link, pending };
const cmd = commands[process.argv[2]];
if (!cmd) {
    console.error(`usage: intake.js ${Object.keys(commands).join("|")} ...`);
    process.exit(2);
}
cmd().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
});
