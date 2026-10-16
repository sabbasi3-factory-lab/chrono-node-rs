#!/usr/bin/env node
"use strict";
// Seed script (DESIGN §6). Deterministic; no AI.
//
//   node seed.js contracts           write contracts/<id>.yaml from upstream/ + taskmap.yaml
//   node seed.js contracts --check   fail if contracts/ differs from a fresh generation
//   node seed.js issues --plan       print the issues the contracts would become (no writes)
//   node seed.js issues --apply      create/update one issue per contract (see guards below)
//
// Inputs: upstream/ (pinned), tests/golden/ (requires per case), the four English configurations
// (tests/golden/configurations.json), factory policies/tiers.yaml at the pinned factory version
// (.github/factory/factory-version), and taskmap.yaml.
const fs = require("fs");
const path = require("path");
const YAML = require("yaml");
const lib = require("./lib");

const REPO = path.resolve(__dirname, "../..");
const REPO_SLUG = "sabbasi3-factory-lab/chrono-node-rs";
const CONTRACTS = path.join(REPO, "contracts");

function read(rel) {
    return fs.readFileSync(path.join(REPO, rel), "utf8");
}

function walk(dir, filter) {
    const out = [];
    if (!fs.existsSync(dir)) return out;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...walk(p, filter));
        else if (filter(p)) out.push(p);
    }
    return out.sort();
}

async function loadInputs() {
    const taskmap = YAML.parse(read("scripts/seed-backlog/taskmap.yaml"));
    const commit = /\| Commit \| `([0-9a-f]{40})` \|/.exec(read("upstream/PINNED.md"))?.[1];
    if (!commit) throw new Error("upstream/PINNED.md has no commit");
    const pin = { commit };

    const upstreamFiles = new Map();
    for (const t of taskmap.tasks) {
        const rel = `${taskmap.upstream_root}/${t.source}`;
        const abs = path.join(REPO, rel);
        if (fs.existsSync(abs)) upstreamFiles.set(rel, fs.readFileSync(abs, "utf8"));
    }

    const configurations = JSON.parse(read("tests/golden/configurations.json")).configurations;
    const cases = [];
    for (const file of walk(path.join(REPO, "tests/golden"), (p) => /\/(core|en)\/[^/]+\.json$/.test(p))) {
        const area = path.relative(path.join(REPO, "tests/golden"), file).replace(/\\/g, "/").replace(/\.json$/, "");
        for (const c of JSON.parse(fs.readFileSync(file, "utf8")).cases) {
            cases.push({ area, requires: [...c.requires.parsers, ...c.requires.refiners] });
        }
    }

    const factoryVersion = read(".github/factory/factory-version").trim();
    if (!/^[0-9a-f]{40}$/.test(factoryVersion)) throw new Error("bad .github/factory/factory-version");
    const url = `https://raw.githubusercontent.com/sabbasi3-factory-lab/factory/${factoryVersion}/policies/tiers.yaml`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`cannot load ${url}: ${res.status}`);
    const tiers = YAML.parse(await res.text());

    return { taskmap, pin, upstreamFiles, configurations, cases, tiers };
}

async function generate() {
    const inputs = await loadInputs();
    const problems = lib.validate(inputs);
    if (problems.length > 0) throw new Error(`task map problems:\n  ${problems.join("\n  ")}`);
    const contracts = lib.buildContracts(inputs);
    const files = new Map(contracts.map((c) => [`${c.id}.yaml`, lib.renderContract(c)]));
    return { contracts, files };
}

function existingContracts() {
    return new Map(
        walk(CONTRACTS, (p) => p.endsWith(".yaml")).map((p) => [path.relative(CONTRACTS, p).replace(/\\/g, "/"), fs.readFileSync(p, "utf8")])
    );
}

async function contractsCommand(check) {
    const { contracts, files } = await generate();
    const existing = existingContracts();
    if (check) {
        const diffs = [...new Set([...files.keys(), ...existing.keys()])].filter((f) => files.get(f) !== existing.get(f)).sort();
        if (diffs.length > 0) {
            console.error(`contracts/ is out of date with taskmap.yaml + inputs: ${diffs.join(", ")}`);
            process.exit(1);
        }
        console.log(`contracts/ matches a fresh generation (${files.size} contracts)`);
        return;
    }
    for (const f of existing.keys()) if (!files.has(f)) fs.rmSync(path.join(CONTRACTS, f));
    for (const [f, text] of files) {
        fs.mkdirSync(path.dirname(path.join(CONTRACTS, f)), { recursive: true });
        fs.writeFileSync(path.join(CONTRACTS, f), text);
    }
    const byTier = {};
    for (const c of contracts) byTier[c.tier] = (byTier[c.tier] || 0) + 1;
    console.log(`wrote ${files.size} contracts to contracts/ (${JSON.stringify(byTier)})`);
}

async function gh(method, apiPath, body) {
    const res = await fetch(`https://api.github.com${apiPath}`, {
        method,
        headers: {
            authorization: `Bearer ${process.env.GH_TOKEN}`,
            accept: "application/vnd.github+json",
            "content-type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${method} ${apiPath}: ${res.status} ${await res.text()}`);
    return res.status === 204 ? null : res.json();
}

async function issuesCommand(apply) {
    const { contracts, files } = await generate();
    const plan = lib.planIssues(contracts, REPO_SLUG);
    if (!apply) {
        console.log(JSON.stringify(plan, null, 2));
        return;
    }
    // Guards: explicit opt-in, and the contracts must already be merged on main exactly as generated.
    if (process.env.FACTORY_SEED_APPLY !== "yes") throw new Error("set FACTORY_SEED_APPLY=yes to create issues");
    if (!process.env.GH_TOKEN) throw new Error("GH_TOKEN is required");
    for (const [f, text] of files) {
        const remote = await gh("GET", `/repos/${REPO_SLUG}/contents/contracts/${f}?ref=main`);
        if (Buffer.from(remote.content, "base64").toString("utf8") !== text) {
            throw new Error(`contracts/${f} on main differs from a fresh generation; merge the contracts PR first`);
        }
    }
    // Find existing issues by marker, so re-runs update instead of duplicating.
    const existing = new Map();
    for (let page = 1; ; page++) {
        const batch = await gh("GET", `/repos/${REPO_SLUG}/issues?labels=factory:task&state=all&per_page=100&page=${page}`);
        for (const i of batch) {
            const m = /<!-- factory-task: ([a-z0-9/-]+) -->/.exec(i.body || "");
            if (m && !i.pull_request) existing.set(m[1], i);
        }
        if (batch.length < 100) break;
    }
    const numbers = new Map();
    for (const p of plan) {
        const id = /factory-task: ([a-z0-9/-]+)/.exec(p.marker)[1];
        const found = existing.get(id);
        const fields = { title: p.title, body: p.body, labels: p.labels };
        const issue = found
            ? await gh("PATCH", `/repos/${REPO_SLUG}/issues/${found.number}`, fields)
            : await gh("POST", `/repos/${REPO_SLUG}/issues`, fields);
        numbers.set(id, issue);
        console.log(`${found ? "updated" : "created"} #${issue.number} ${id}`);
    }
    // Dependency links ("blocked by"), idempotent.
    for (const p of plan) {
        const id = /factory-task: ([a-z0-9/-]+)/.exec(p.marker)[1];
        const issue = numbers.get(id);
        const current = await gh("GET", `/repos/${REPO_SLUG}/issues/${issue.number}/dependencies/blocked_by`);
        const have = new Set(current.map((i) => i.id));
        for (const dep of p.blocked_by) {
            const blocker = numbers.get(dep);
            if (!have.has(blocker.id)) {
                await gh("POST", `/repos/${REPO_SLUG}/issues/${issue.number}/dependencies/blocked_by`, { issue_id: blocker.id });
            }
        }
    }
}

async function main() {
    const [command, ...flags] = process.argv.slice(2);
    if (command === "contracts") return contractsCommand(flags.includes("--check"));
    if (command === "issues" && flags.includes("--plan")) return issuesCommand(false);
    if (command === "issues" && flags.includes("--apply")) return issuesCommand(true);
    console.error("usage: seed.js contracts [--check] | issues --plan | issues --apply");
    process.exit(2);
}

main().catch((e) => {
    console.error(e.message);
    process.exit(1);
});
