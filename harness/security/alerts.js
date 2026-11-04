#!/usr/bin/env node
"use strict";
// Dependabot security alerts → the dependency steward, not Dependabot PRs (Dependabot security
// updates stay off: Cargo.toml and Cargo.lock change only through the steward). Plain code, no AI.
//
//   node security/alerts.js plan --alerts ALERTS.json --issues ISSUES.json > PLAN.json   (no token needed)
//   node security/alerts.js apply --plan PLAN.json                                       (live: controller App token)
//
// Routing (classify()):
// - cargo (the shipped crate's Cargo.lock): one `dependency-security` issue per advisory for the
//   steward, `needs-human` until the steward can update a locked crate (today it only adds crates);
// - npm under upstream/: the vendored chrono-node's own dev tooling, run in CI only as the judge and
//   never shipped. Fixed by an upstream bump (upstream-sync), so no issue: counted in the summary;
// - anything else (e.g. harness/ npm tooling): one `dependency-security` issue per advisory, human tier.
// Each issue carries `<!-- factory-security: <GHSA> <manifest> -->`, so a re-run never files it twice.
// `apply` loads no third-party module.
const fs = require("fs");

const MARKER = (ghsa, manifest) => `<!-- factory-security: ${ghsa} ${manifest} -->`;
const GHSA = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/;
const LABELS = ["dependency-security", "needs-human"];

/** One alert → its route: "steward" | "upstream-bump" | "human", or null if it isn't one we act on. */
function classify(a) {
    const eco = a?.dependency?.package?.ecosystem;
    const manifest = a?.dependency?.manifest_path || "";
    if (a?.state !== "open") return null;
    if (eco === "cargo" || eco === "rust") return "steward";
    if (eco === "npm" && manifest.startsWith("upstream/")) return "upstream-bump";
    return "human";
}

function safe(s, n = 200) {
    return String(s ?? "").replace(/[^\w .,:;()@/+\-<>=*~^|]/g, "").slice(0, n);
}

/** The issues to open (deduped by marker against existing issues, open or closed) and a summary. */
function plan(alerts, existingBodies) {
    const have = new Set();
    for (const b of existingBodies) for (const m of String(b || "").matchAll(/<!-- factory-security: (\S+) (\S+) -->/g)) have.add(`${m[1]} ${m[2]}`);
    const out = { issues: [], summary: { steward: 0, "upstream-bump": 0, human: 0 } };
    const seen = new Set();
    for (const a of alerts) {
        const route = classify(a);
        if (!route) continue;
        out.summary[route]++;
        if (route === "upstream-bump") continue;
        const ghsa = a.security_advisory?.ghsa_id;
        const manifest = a.dependency?.manifest_path;
        if (!GHSA.test(ghsa || "") || !/^[A-Za-z0-9._/-]{1,200}$/.test(manifest || "")) continue;
        const key = `${ghsa} ${manifest}`;
        if (have.has(key) || seen.has(key)) continue;
        seen.add(key);
        const pkg = safe(a.dependency.package.name, 100);
        const sev = safe(a.security_advisory.severity, 20);
        const vuln = safe(a.security_vulnerability?.vulnerable_version_range, 100);
        const fixed = safe(a.security_vulnerability?.first_patched_version?.identifier, 50) || "none yet";
        out.issues.push({
            title: `[security] ${pkg} (${sev}): ${ghsa}`,
            labels: LABELS,
            body: [
                MARKER(ghsa, manifest),
                `**Security advisory** ${ghsa} (${sev}) for \`${pkg}\` in \`${manifest}\` (${route === "steward" ? "the shipped crate's dependencies" : "repository tooling"}), from Dependabot alerts. Plain code, no AI.`,
                "",
                `- Vulnerable: \`${vuln}\` · first patched: \`${fixed}\``,
                `- Advisory: https://github.com/advisories/${ghsa}`,
                route === "steward"
                    ? "- Route: the dependency steward (Cargo.toml / Cargo.lock change only through it; Dependabot opens no PRs). Until the steward can update a locked crate, a person files the update."
                    : "- Route: a person (human-tier tooling).",
            ].join("\n"),
        });
    }
    return out;
}

async function apply(file) {
    const { gh, paginate, REPO } = require("../feedback/github");
    const p = JSON.parse(fs.readFileSync(file, "utf8"));
    const labels = new Set((await paginate(`/repos/${REPO}/labels`)).map((l) => l.name));
    for (const l of LABELS) if (!labels.has(l)) await gh("POST", `/repos/${REPO}/labels`, { name: l, color: "B60205" });
    const existing = (await paginate(`/repos/${REPO}/issues?labels=dependency-security&state=all`)).map((i) => i.body || "");
    const keys = new Set(existing.flatMap((b) => [...b.matchAll(/<!-- factory-security: (\S+) (\S+) -->/g)].map((m) => `${m[1]} ${m[2]}`)));
    for (const i of p.issues) {
        const m = /^<!-- factory-security: (\S+) (\S+) -->/.exec(i.body);
        if (!m || !GHSA.test(m[1]) || JSON.stringify(i.labels) !== JSON.stringify(LABELS) || !i.title.startsWith("[security] ")) throw new Error("bad plan entry");
        if (keys.has(`${m[1]} ${m[2]}`)) continue;
        const created = await gh("POST", `/repos/${REPO}/issues`, { title: i.title.slice(0, 200), body: i.body.slice(0, 4000), labels: i.labels });
        console.log(`created #${created.number} ${m[1]} ${m[2]}`);
    }
}

function main() {
    const opt = (n) => {
        const i = process.argv.indexOf(n);
        return i > 0 ? process.argv[i + 1] : null;
    };
    const cmd = process.argv[2];
    if (cmd === "plan") {
        const alerts = JSON.parse(fs.readFileSync(opt("--alerts"), "utf8"));
        const bodies = JSON.parse(fs.readFileSync(opt("--issues"), "utf8")).map((i) => i.body);
        console.log(JSON.stringify(plan(alerts, bodies), null, 2));
        return;
    }
    if (cmd === "apply") return apply(opt("--plan"));
    console.error("usage: alerts.js plan --alerts F --issues F | apply --plan F");
    process.exit(2);
}

if (require.main === module) {
    Promise.resolve(main()).catch((e) => {
        console.error(e.message);
        process.exit(1);
    });
}

module.exports = { classify, plan, MARKER };
