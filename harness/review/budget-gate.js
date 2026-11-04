#!/usr/bin/env node
"use strict";
// Daily budget gate for the factory review (improve.md), before any inference. The controller
// dispatches the other AI workflows behind its budget pause; this one starts from cron, so it checks
// the same thing itself: today's newest live spend_snapshot (audit branch) plus this run's worst
// case must stay under factory_per_day.max_aic × pause_at_pct. Unknown spend → no run (fail closed).
//
//   node review/budget-gate.js [--now ISO]     (needs origin/audit fetched)
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO_DIR = path.resolve(__dirname, "../..");
const opt = (name) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : null;
};

/** Pure: may the run start? reasons are printed. */
function gate({ snapshots, budgets, now }) {
    const day = now.toISOString().slice(0, 10);
    const today = snapshots.filter((e) => e.type === "spend_snapshot" && e.payload && e.payload.dry_run === false && e.payload.day === day);
    const last = today[today.length - 1];
    if (!last || typeof last.payload.aic_today !== "number") return { ok: false, why: `no live spend_snapshot for ${day} with a known total` };
    const pr = budgets.per_run;
    const margin = Number(pr.overshoot_margin) || 0;
    const worst = pr.factory_review + pr.threat_detection + 2 * margin;
    const limit = (budgets.factory_per_day.max_aic * budgets.factory_per_day.pause_at_pct) / 100;
    const total = last.payload.aic_today + worst;
    return { ok: total <= limit, why: `today ${last.payload.aic_today} AIC + this run's worst case ${worst} = ${total} vs pause at ${limit}` };
}

async function main() {
    const now = new Date(opt("--now") || Date.now());
    const pin = fs.readFileSync(path.join(REPO_DIR, ".github/factory/factory-version"), "utf8").trim();
    if (!/^[0-9a-f]{40}$/.test(pin)) throw new Error("bad factory-version");
    const res = await fetch(`https://raw.githubusercontent.com/sabbasi3-factory-lab/factory/${pin}/policies/budgets.yaml`);
    if (!res.ok) throw new Error(`budgets.yaml: ${res.status}`);
    const budgets = require("yaml").parse(await res.text());
    let text = "";
    try {
        text = execFileSync("git", ["show", `origin/audit:audit/${now.toISOString().slice(0, 10).replace(/-/g, "/")}.jsonl`], { cwd: REPO_DIR, encoding: "utf8", maxBuffer: 1 << 28 });
    } catch {
        text = "";
    }
    const snapshots = text.split("\n").filter((l) => l.includes('"spend_snapshot"')).map((l) => JSON.parse(l));
    const g = gate({ snapshots, budgets, now });
    console.log(`${g.ok ? "ok" : "no run"}: ${g.why}`);
    if (!g.ok) process.exitCode = 1;
}

module.exports = { gate };

if (require.main === module) {
    main().catch((e) => {
        console.error(`budget gate failed closed: ${e.message}`);
        process.exitCode = 1;
    });
}
