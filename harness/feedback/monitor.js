#!/usr/bin/env node
"use strict";
// Nightly monitor, filing step (DESIGN §6, §8). Plain code, no AI. Reads the report of a fresh-seed
// comparison run (compare.js --report) and files one issue per new mismatch signature.
//
//   node feedback/monitor.js --report report.json --phrases N [--live] [--drill] [--max-new 3]
//
// - Dedupe: an open issue created by the controller App carrying `<!-- factory-monitor: <signature> -->`
//   (the bug report, or the fix task it became) means the signature is known. The monitor's own report gets its
//   "Last seen" line updated; a task issue is left alone.
// - At most --max-new new issues per run; the rest are listed in the run summary only.
// - Labels: `monitor` + `factory:bug` (the intake triages it). A drill (--drill, from
//   compare.js --plant) uses `monitor` + `drill` instead, so the intake never acts on it, and
//   closes its issue right after filing it: it proves a planted mismatch reaches an issue.
// - Without --live (FACTORY_ENABLED isn't "true"): prints what it would do, writes nothing.
// - Errors (a request Rust or chrono-node couldn't run) aren't filed: the run fails instead.
const fs = require("fs");
const lib = require("./lib");
const { REPO, gh, openIssues } = require("./github");

function args(argv) {
    const a = { report: null, phrases: 0, live: false, drill: false, maxNew: 3 };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--report") a.report = argv[++i];
        else if (argv[i] === "--phrases") a.phrases = Number(argv[++i]);
        else if (argv[i] === "--live") a.live = true;
        else if (argv[i] === "--drill") a.drill = true;
        else if (argv[i] === "--max-new") a.maxNew = Number(argv[++i]);
        else throw new Error(`unknown argument ${argv[i]}`);
    }
    if (!a.report || !Number.isInteger(a.phrases) || a.phrases < 1 || !Number.isInteger(a.maxNew) || a.maxNew < 0 || a.maxNew > 10) throw new Error("usage: monitor.js --report FILE --phrases N [--live] [--drill] [--max-new 0-10]");
    return a;
}

async function main() {
    const a = args(process.argv.slice(2));
    const report = JSON.parse(fs.readFileSync(a.report, "utf8"));
    const date = new Date().toISOString().slice(0, 10);
    // --phrases: the per-language count compare.js ran with (the reproduce command needs it).
    const ctx = { seed: report.seed, phrases: a.phrases, runUrl: process.env.RUN_URL || null, drill: a.drill, date };
    const groups = lib.groupMismatches(report.mismatches);
    const lines = [`## Monitor ${date}`, "", `seed \`${report.seed}\` · ${JSON.stringify(report.summary)}`, ""];
    const known = new Map();
    // Only markers in issues the factory created count: a copied marker in someone else's issue
    // must not suppress a report.
    for (const i of process.env.GH_TOKEN ? await openIssues() : []) {
        if (!i.user || i.user.login !== lib.FACTORY_BOT) continue;
        const m = lib.MONITOR_MARKER_RE.exec(i.body || "");
        if (m && !known.has(m[1])) known.set(m[1], i);
    }
    let filed = 0;
    for (const g of groups) {
        const issue = known.get(g.signature);
        const { title, body } = lib.renderMonitorIssue(g, ctx);
        if (issue) {
            const updated = lib.updateLastSeen(issue.body, { date, runUrl: ctx.runUrl, seed: report.seed, count: g.count });
            lines.push(`- \`${g.signature}\` (${g.count}): already #${issue.number}${updated ? ", last-seen updated" : ""}`);
            if (a.live && updated && !a.drill) await gh("PATCH", `/repos/${REPO}/issues/${issue.number}`, { body: updated });
            continue;
        }
        if (filed >= a.maxNew) {
            lines.push(`- \`${g.signature}\` (${g.count}): not filed (cap of ${a.maxNew} new issues per run)`);
            continue;
        }
        filed++;
        const labels = a.drill ? ["monitor", "drill"] : ["monitor", "factory:bug"];
        if (!a.live) {
            lines.push(`- \`${g.signature}\` (${g.count}): [dry-run] would open "${title}" with ${labels.join(", ")}`);
            console.log(`---- [dry-run] issue body ----\n${body}\n----`);
            continue;
        }
        const created = await gh("POST", `/repos/${REPO}/issues`, { title, body, labels });
        lines.push(`- \`${g.signature}\` (${g.count}): opened #${created.number}`);
        if (a.drill) {
            await gh("POST", `/repos/${REPO}/issues/${created.number}/comments`, { body: "**Factory monitor** · drill: the planted mismatch reached this issue. Closing." });
            await gh("PATCH", `/repos/${REPO}/issues/${created.number}`, { state: "closed", state_reason: "completed" });
        }
    }
    if (groups.length === 0) lines.push("No mismatches.");
    if (report.errors.length > 0) lines.push("", `**${report.errors.length} error(s)**: see the comparison step's log (not filed; the run fails).`);
    const summary = lines.join("\n") + "\n";
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
    if (report.errors.length > 0) process.exitCode = 1;
}

main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
});
