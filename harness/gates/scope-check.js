#!/usr/bin/env node
"use strict";
// Scope check + contract SHA (DESIGN §9 gates 1-2).
//
// GATE_MODE=enforce (the `gates` workflow): this file and its dependencies come from the TRUSTED
//   base checkout (pull_request_target / merge_group base). The candidate commit is only read as
//   git data (diff, show); nothing from it is executed. Fails the job on any violation.
// GATE_MODE=outputs (the `checks` job): computes the contract's golden areas, step and visible
//   seed for the test steps and never fails on policy (the trusted gate does that).
//
// - Human PRs (no `Factory-Task:` trailer, not authored by the agent App) pass; the changed paths
//   are printed with nothing enforced.
// - Factory PRs must: have a contract on the trusted tip (enforce: the default-branch tip), declare `Contract-SHA:` equal to (a
//   prefix of) the last commit that touched it there, change only paths inside the contract
//   `scope`, and touch nothing in `protected_from_agents` from factory policies/tiers.yaml (at the
//   pinned factory version in the trusted .github/factory/factory-version). Diffs use
//   --no-renames, so a moved file counts as a deletion plus an addition. Agent PRs without a task
//   fail.
// Writes kind, golden_areas, golden_step, differential_seed, differential_phrases and strict (the
// change needs the auto-strict full regression) to $GITHUB_OUTPUT.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const YAML = require("yaml");
const { evaluate, needsFullRegression } = require("./scope");

// The trusted checkout (this file's repo); the candidate commit must already be fetched into it.
const REPO = path.resolve(__dirname, "../..");
const MODE = process.env.GATE_MODE || "enforce";
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
    const strict = tiers && tiers.tiers && tiers.tiers["auto-strict"] && tiers.tiers["auto-strict"].paths;
    return { version, protectedGlobs: list, autoStrictGlobs: Array.isArray(strict) ? strict : [] };
}

const changedPaths = (from, to) => git("diff", "--name-only", "--no-renames", from, to);

async function context() {
    const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    const repo = process.env.GITHUB_REPOSITORY;
    const name = process.env.GITHUB_EVENT_NAME;
    if (name === "pull_request" || name === "pull_request_target") {
        const pr = event.pull_request;
        const head = pr.head.sha;
        // Diff from the merge base (what the PR changes). Contracts come from the trusted tip when
        // enforcing (TRUSTED_SHA = default-branch tip: a stacked PR's base branch is not trusted),
        // otherwise from the current base tip, so a contract updated after the branch diverged applies.
        const mergeBase = git("merge-base", pr.base.sha, head);
        const contractBase = (MODE === "enforce" && process.env.TRUSTED_SHA) || pr.base.sha;
        return { pr, head, contractBase, changed: changedPaths(mergeBase, head) };
    }
    if (name === "merge_group") {
        // Each queue entry is this PR's squash commit on top of main + earlier entries.
        const m = /\/pr-(\d+)-[0-9a-f]+$/.exec(event.merge_group.head_ref);
        if (!m) throw new Error(`cannot find PR number in ${event.merge_group.head_ref}`);
        const pr = await gh(`/repos/${repo}/pulls/${m[1]}`);
        const head = event.merge_group.head_sha;
        return { pr, head, contractBase: `${head}^`, changed: changedPaths(`${head}^`, head) };
    }
    throw new Error(`unsupported event ${name}`);
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
    const { pr, head, contractBase, changed } = await context();
    const changedPaths = changed ? changed.split("\n").filter(Boolean) : [];
    const { version, protectedGlobs, autoStrictGlobs } = await loadPolicyProtected();
    const isAgent = pr.user && pr.user.login === AGENT_LOGIN;
    const loadContract = loadContractAt(contractBase);
    const result = evaluate({ isAgent, body: pr.body, changed: changedPaths, protectedGlobs, loadContract });
    let contractTier = null;
    if (result.task) {
        try {
            contractTier = (loadContract(result.task) || {}).tier || null;
        } catch {
            contractTier = "auto-strict"; // unreadable contract: fail closed (run the full regression)
        }
    }
    const strict = needsFullRegression({ changed: changedPaths, autoStrictGlobs, contractTier });

    console.log(`mode ${MODE}; factory policies at ${version}; candidate ${head}; contracts from ${contractBase}`);
    console.log(`PR #${pr.number} by ${pr.user && pr.user.login}: ${result.kind}${result.task ? ` task ${result.task}` : ""}`);
    console.log(`full regression (auto-strict): ${strict ? "yes" : "no"}`);
    console.log(`changed paths (${changedPaths.length}):`);
    for (const p of changedPaths) console.log(`  ${p}`);
    if (process.env.GITHUB_OUTPUT) {
        const d = result.differential || { seed: 42, phrases: 2000 };
        fs.appendFileSync(
            process.env.GITHUB_OUTPUT,
            [
                `kind=${result.kind}`,
                `golden_areas=${result.goldenAreas.join(",")}`,
                `golden_step=${result.goldenStep || ""}`,
                `differential_seed=${d.seed}`,
                `differential_phrases=${d.phrases}`,
                `strict=${strict ? "true" : "false"}`,
            ].join("\n") + "\n"
        );
    }
    if (!result.ok) {
        if (MODE === "outputs") {
            for (const r of result.reasons) console.log(`::warning::${r} (enforced by the gates job)`);
            return;
        }
        for (const r of result.reasons) console.log(`::error::${r}`);
        process.exitCode = 1;
        return;
    }
    console.log(result.kind === "human" ? "human PR: scope gate not applicable" : "scope and contract SHA ok");
}

main().catch((e) => {
    console.log(`::error::scope check failed closed: ${e.message}`);
    process.exitCode = 1;
});
