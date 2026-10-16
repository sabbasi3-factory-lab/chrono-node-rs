#!/usr/bin/env node
"use strict";
// CI gate: scope check + contract SHA (DESIGN §9 gates 1-2). Run in GitHub Actions on
// pull_request and merge_group.
//
// - Human PRs (no `Factory-Task:` trailer, not authored by the agent App) pass; the changed paths
//   are printed with nothing enforced.
// - Factory PRs must: have a contract on the base, declare `Contract-SHA:` equal to (a prefix of)
//   the last commit that touched it, change only paths inside the contract `scope`, and touch
//   nothing in `protected_from_agents` from factory policies/tiers.yaml (at the pinned factory
//   version in .github/factory/factory-version). Agent PRs without a task fail.
// Writes `golden_areas=<a,b>` and `kind=` to $GITHUB_OUTPUT for the contract golden step.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const YAML = require("yaml");
const { evaluate } = require("./scope");

const REPO = path.resolve(__dirname, "../..");
const AGENT_LOGIN = "sabbasi3-factory-agent[bot]";

const git = (...args) => execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim();

async function gh(apiPath) {
    const res = await fetch(`https://api.github.com${apiPath}`, {
        headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`GET ${apiPath}: ${res.status}`);
    return res.json();
}

async function loadPolicyProtected() {
    const version = fs.readFileSync(path.join(REPO, ".github/factory/factory-version"), "utf8").trim();
    if (!/^[0-9a-f]{40}$/.test(version)) throw new Error("bad .github/factory/factory-version");
    const url = `https://raw.githubusercontent.com/sabbasi3-factory-lab/factory/${version}/policies/tiers.yaml`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`cannot load ${url}: ${res.status}`);
    const tiers = YAML.parse(await res.text());
    const list = tiers && tiers.protected_from_agents;
    if (!Array.isArray(list) || list.length === 0) throw new Error("tiers.yaml has no protected_from_agents");
    return { version, protectedGlobs: list };
}

async function context() {
    const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    const repo = process.env.GITHUB_REPOSITORY;
    if (process.env.GITHUB_EVENT_NAME === "pull_request") {
        const pr = event.pull_request;
        const base = pr.base.sha;
        const head = pr.head.sha;
        const mergeBase = git("merge-base", base, head);
        return { pr, base: mergeBase, changed: git("diff", "--name-only", mergeBase, head) };
    }
    if (process.env.GITHUB_EVENT_NAME === "merge_group") {
        // Each queue entry is this PR's squash commit on top of main + earlier entries.
        const m = /\/pr-(\d+)-[0-9a-f]+$/.exec(event.merge_group.head_ref);
        if (!m) throw new Error(`cannot find PR number in ${event.merge_group.head_ref}`);
        const pr = await gh(`/repos/${repo}/pulls/${m[1]}`);
        const head = event.merge_group.head_sha;
        return { pr, base: `${head}^`, changed: git("diff", "--name-only", `${head}^`, head) };
    }
    throw new Error(`unsupported event ${process.env.GITHUB_EVENT_NAME}`);
}

function loadContractAt(base) {
    return (task) => {
        const file = `contracts/${task}.yaml`;
        let text;
        try {
            text = git("show", `${base}:${file}`);
        } catch {
            return null;
        }
        const doc = YAML.parse(text);
        const lastCommit = git("log", "-1", "--format=%H", base, "--", file);
        return { ...doc, lastCommit };
    };
}

async function main() {
    const { pr, base, changed } = await context();
    const changedPaths = changed ? changed.split("\n").filter(Boolean) : [];
    const { version, protectedGlobs } = await loadPolicyProtected();
    const isAgent = pr.user && pr.user.login === AGENT_LOGIN;
    const result = evaluate({ isAgent, body: pr.body, changed: changedPaths, protectedGlobs, loadContract: loadContractAt(base) });

    console.log(`factory policies at ${version}`);
    console.log(`PR #${pr.number} by ${pr.user && pr.user.login}: ${result.kind}${result.task ? ` task ${result.task}` : ""}`);
    console.log(`changed paths (${changedPaths.length}):`);
    for (const p of changedPaths) console.log(`  ${p}`);
    if (process.env.GITHUB_OUTPUT) {
        fs.appendFileSync(process.env.GITHUB_OUTPUT, `kind=${result.kind}\ngolden_areas=${result.goldenAreas.join(",")}\n`);
    }
    if (!result.ok) {
        for (const r of result.reasons) console.log(`::error::${r}`);
        process.exit(1);
    }
    console.log(result.kind === "human" ? "human PR: scope gate not applicable" : "scope and contract SHA ok");
}

main().catch((e) => {
    console.log(`::error::scope check failed closed: ${e.message}`);
    process.exit(1);
});
