#!/usr/bin/env node
"use strict";
// Task issues for a generated locale's contracts, after its onboarding PR merges (onboard.yml).
// Plain code; loads no third-party module (Node built-ins and this repo only), because it runs with
// the controller App's write token.
//
//   node onboard/issues.js pending               generated contract ids on main without a task issue
//   node onboard/issues.js create --plan F.json  (live) create those issues and their "blocked by" links,
//                                                from `seed.js issues --plan --only <ids>` (run without a token)
//
// Only plan entries for generated locales' tasks are accepted; labels are created if missing.
// Never creates a marker twice. No issue gets `factory:ready`: the controller's auto-ready decides.
const fs = require("fs");
const path = require("path");
const LOCALES = require("../lib/locales");
const { REPO, gh, paginate } = require("../feedback/github");

const ROOT = path.resolve(__dirname, "../..");
const MARKER = /^<!-- factory-task: ([a-z0-9/-]+) -->$/;

/** Generated locales' contract ids on this checkout (fix contracts excluded: the intake owns them). */
function generatedIds() {
    const ids = [];
    for (const l of LOCALES.generatedLocales(ROOT)) {
        const dir = path.join(ROOT, "contracts", l.code);
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir).sort()) {
            if (f.endsWith(".yaml") && !f.startsWith("fix-")) ids.push(`${l.code}/${f.slice(0, -5)}`);
        }
    }
    return ids;
}

async function taskIssues() {
    const out = new Map();
    for (const i of await paginate(`/repos/${REPO}/issues?labels=factory:task&state=all`)) {
        const m = /<!-- factory-task: ([a-z0-9/-]+) -->/.exec(i.body || "");
        if (m && !i.pull_request) out.set(m[1], i);
    }
    return out;
}

async function pending() {
    const have = await taskIssues();
    console.log(generatedIds().filter((id) => !have.has(id)).join(","));
}

async function create() {
    const i = process.argv.indexOf("--plan");
    const plan = JSON.parse(fs.readFileSync(process.argv[i + 1], "utf8"));
    const allowed = new Set(generatedIds());
    const ids = plan.map((p) => {
        const id = (MARKER.exec(p.marker) || [])[1];
        if (!id || !allowed.has(id) || !p.body.startsWith(p.marker)) throw new Error(`not a generated task plan entry: ${String(p.marker).slice(0, 80)}`);
        for (const l of p.labels) if (!/^(factory:task|tier:[a-z-]+|area:[a-z0-9-]+)$/.test(l)) throw new Error(`unexpected label ${l}`);
        for (const d of p.blocked_by) if (typeof d !== "string" || !/^[a-z0-9-]+\/[a-z0-9-]+$/.test(d)) throw new Error(`bad dependency ${d}`);
        return id;
    });
    const issues = await taskIssues();
    const labels = new Set((await paginate(`/repos/${REPO}/labels`)).map((l) => l.name));
    for (const [k, p] of plan.entries()) {
        if (issues.has(ids[k])) continue;
        for (const l of p.labels) {
            if (!labels.has(l)) await gh("POST", `/repos/${REPO}/labels`, { name: l, color: "EDEDED" });
            labels.add(l);
        }
        const created = await gh("POST", `/repos/${REPO}/issues`, { title: p.title, body: p.body, labels: p.labels });
        issues.set(ids[k], created);
        console.log(`created #${created.number} ${ids[k]}`);
    }
    // "Blocked by" links, idempotent. A dependency outside the plan must already have an issue.
    for (const [k, p] of plan.entries()) {
        const issue = issues.get(ids[k]);
        const current = new Set(((await gh("GET", `/repos/${REPO}/issues/${issue.number}/dependencies/blocked_by`)) || []).map((x) => x.id));
        for (const d of p.blocked_by) {
            const blocker = issues.get(d);
            if (!blocker) throw new Error(`${ids[k]} depends on ${d}, which has no task issue`);
            if (!current.has(blocker.id)) await gh("POST", `/repos/${REPO}/issues/${issue.number}/dependencies/blocked_by`, { issue_id: blocker.id });
        }
    }
}

const commands = { pending, create };
const cmd = commands[process.argv[2]];
if (!cmd) {
    console.error(`usage: issues.js ${Object.keys(commands).join("|")} ...`);
    process.exit(2);
}
cmd().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
});
