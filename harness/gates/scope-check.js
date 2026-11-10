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
// - merge_group (enforce): an agent PR with an auto-strict change also needs the reviewer App's
//   passing `factory-review` on its head, unless a person enqueued it (scope.js reviewGate).
// - Factory v2 PRs (`Factory-Unit: <lang>`, docs/factory-v2.md): the same checks over the union of the
//   language's contracts on the trusted tip, for languages in its .github/factory/v2.yaml only.
// Writes kind, golden_areas, golden_step, unit, unit_golden, differential_seed, differential_phrases, strict (the
// change needs the auto-strict full regression) and intake (a bug-intake fix PR) to $GITHUB_OUTPUT.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const YAML = require("yaml");
const { evaluate, needsFullRegression, reviewGate } = require("./scope");

// The trusted checkout (this file's repo); the candidate commit must already be fetched into it.
const REPO = path.resolve(__dirname, "../..");
const MODE = process.env.GATE_MODE || "enforce";
const AGENT_LOGIN = "sabbasi3-factory-agent[bot]";
const CONTROLLER_LOGIN = "sabbasi3-factory-controller[bot]";
/** A dependency-steward PR: the controller App on `factory/deps/<crate>-<x.y.z>` (harness/steward). */
const isStewardPr = (pr) =>
    Boolean(pr && pr.user && pr.user.login === CONTROLLER_LOGIN && pr.head && /^factory\/deps\/[A-Za-z0-9_-]+-\d+\.\d+\.\d+$/.test(pr.head.ref || ""));

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

async function graphql(query, variables) {
    const res = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: { authorization: `bearer ${process.env.GH_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`graphql: ${res.status}`);
    const j = await res.json();
    if (j.errors) throw new Error(`graphql: ${JSON.stringify(j.errors).slice(0, 200)}`);
    return j.data;
}

const ENQUEUER_QUERY = `query($owner: String!, $name: String!, $n: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $n) {
  timelineItems(itemTypes: [ADDED_TO_MERGE_QUEUE_EVENT], last: 1) { nodes { ... on AddedToMergeQueueEvent { actor { __typename login } } } } } } }`;

/** Who put the PR in the queue (last AddedToMergeQueueEvent) and the factory-review runs on its head. Errors → null (fail closed). */
async function reviewInputs(repo, pr) {
    const [owner, name] = repo.split("/");
    let enqueuer = null;
    try {
        const d = await graphql(ENQUEUER_QUERY, { owner, name, n: pr.number });
        const a = d.repository.pullRequest.timelineItems.nodes.slice(-1)[0];
        if (a && a.actor) enqueuer = { type: a.actor.__typename, login: a.actor.login };
    } catch (e) {
        console.log(`enqueuer unreadable (${e.message}): treated as not a person`);
    }
    let checkRuns = null;
    try {
        checkRuns = (await gh(`/repos/${repo}/commits/${pr.head.sha}/check-runs?check_name=factory-review&filter=all&per_page=100`)).check_runs;
    } catch (e) {
        console.log(`factory-review check runs unreadable (${e.message})`);
    }
    return { enqueuer, checkRuns };
}

/** The merge_group review gate end to end: reads the enqueuer and verdicts only when required. */
async function mergeGroupReview({ repo, pr, isAgent, strict }) {
    const inputs = isAgent && strict ? await reviewInputs(repo, pr) : { enqueuer: null, checkRuns: null };
    return reviewGate({ isAgent, strict, head: pr.head && pr.head.sha, ...inputs });
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
    if (name === "push" && MODE === "outputs") {
        // Post-merge check of a main commit (ci only): its own diff, no PR, nothing enforced.
        const head = process.env.GITHUB_SHA;
        if (!/^[0-9a-f]{40}$/.test(head || "")) throw new Error("GITHUB_SHA missing");
        return { pr: { number: 0, user: null, body: "" }, head, contractBase: `${head}^`, changed: changedPaths(`${head}^`, head) };
    }
    throw new Error(`unsupported event ${name}`);
}

/**
 * Factory v2 (docs/factory-v2.md): a language's contracts at `base`, whether it's a v2 language there
 * (.github/factory/v2.yaml `languages`; a missing or unreadable file means none), and the last commit to
 * contracts/<unit>/. Null if the language has no contracts.
 */
function loadUnitAt(base) {
    return (unit) => {
        let files;
        try {
            files = git("ls-tree", "--name-only", `${base}:contracts/${unit}`).split("\n").filter((f) => f.endsWith(".yaml"));
        } catch {
            return null;
        }
        if (files.length === 0) return null;
        let enabled = false;
        try {
            const v2 = YAML.parse(git("show", `${base}:.github/factory/v2.yaml`));
            enabled = Boolean(v2 && Array.isArray(v2.languages) && v2.languages.includes(unit));
        } catch {
            enabled = false;
        }
        const contracts = files.map((f) => YAML.parse(git("show", `${base}:contracts/${unit}/${f}`)));
        const lastCommit = git("log", "-1", "--format=%H", base, "--", `contracts/${unit}/`);
        return { enabled, contracts, lastCommit };
    };
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
    // Candidate files are read as git data only (never executed); a deleted file reads as null.
    const readFile = (p) => {
        try {
            return git("show", `${head}:${p}`);
        } catch {
            return null;
        }
    };
    const loadUnit = loadUnitAt(contractBase);
    const result = evaluate({ isAgent, body: pr.body, changed: changedPaths, protectedGlobs, loadContract, loadUnit, readFile });
    // The dependency steward's PRs (controller App, factory/deps/*) have no task, but they merge
    // without a person: the strict gates must be enforced on them exactly as on factory PRs.
    const steward = isStewardPr(pr);
    // A factory PR's contract decides too (its tier and every scope path). A missing or unreadable
    // contract fails closed: run the full regression.
    let strict;
    if (result.task) {
        let contract = null;
        try {
            contract = loadContract(result.task);
        } catch {
            contract = null;
        }
        strict = contract
            ? needsFullRegression({ changed: changedPaths, autoStrictGlobs, contractTier: contract.tier || null, contractScope: contract.scope })
            : true;
    } else if (result.unit) {
        // A v2 unit: any of its contracts' tiers or scope paths. Unreadable contracts fail closed.
        let u = null;
        try {
            u = loadUnit(result.unit);
        } catch {
            u = null;
        }
        strict = u
            ? u.contracts.some((c) => c.tier === "auto-strict") ||
              needsFullRegression({ changed: changedPaths, autoStrictGlobs, contractTier: null, contractScope: u.contracts.flatMap((c) => c.scope || []) })
            : true;
    } else if (process.env.GITHUB_EVENT_NAME === "push") {
        // Post-merge check on main: the merged PR's task and contract aren't known here, so run the
        // full regression on every main commit (conservative: it ran before merging too).
        strict = true;
    } else {
        strict = needsFullRegression({ changed: changedPaths, autoStrictGlobs, contractTier: null });
    }

    if (MODE === "enforce" && process.env.GITHUB_EVENT_NAME === "merge_group" && result.ok) {
        const gate = await mergeGroupReview({ repo: process.env.GITHUB_REPOSITORY, pr, isAgent, strict });
        console.log(gate.why);
        if (!gate.ok) {
            result.ok = false;
            result.reasons.push(gate.why);
        }
    }

    console.log(`mode ${MODE}; factory policies at ${version}; candidate ${head}; contracts from ${contractBase}`);
    console.log(`PR #${pr.number} by ${pr.user && pr.user.login}: ${result.kind}${result.task ? ` task ${result.task}` : ""}${result.unit ? ` unit ${result.unit}` : ""}`);
    console.log(`full regression (auto-strict): ${strict ? "yes" : "no"}`);
    console.log(`changed paths (${changedPaths.length}):`);
    for (const p of changedPaths) console.log(`  ${p}`);
    if (process.env.GITHUB_OUTPUT) {
        const d = result.differential || { seed: 42, phrases: 2000 };
        fs.appendFileSync(
            process.env.GITHUB_OUTPUT,
            [
                `kind=${steward ? "factory" : result.kind}`,
                `golden_areas=${result.goldenAreas.join(",")}`,
                `golden_step=${result.goldenStep || ""}`,
                // Factory v2: one `<step>:<area>,<area>` per contract with golden acceptance, space-separated.
                `unit=${result.unit || ""}`,
                `unit_golden=${(result.unitGolden || []).map((g) => `${g.step}:${g.areas.join(",")}`).join(" ")}`,
                `differential_seed=${d.seed}`,
                `differential_phrases=${d.phrases}`,
                `strict=${strict ? "true" : "false"}`,
                // A bug-intake fix PR (also in the merge group, where the PR is looked up by number).
                `intake=${/^factory\/intake\//.test((pr.head && pr.head.ref) || "") ? "true" : "false"}`,
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

module.exports = { mergeGroupReview, isStewardPr };

if (require.main === module) {
    main().catch((e) => {
        console.log(`::error::scope check failed closed: ${e.message}`);
        process.exitCode = 1;
    });
}
