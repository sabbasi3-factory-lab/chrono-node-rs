"use strict";
// Pure logic of the scope and contract-SHA gates (DESIGN §9 gates 1-2). See scope-check.js.

/** Glob -> RegExp: `**` crosses directories, `*` and `?` don't. Anchored on the whole path. */
function globToRegExp(glob) {
    let re = "";
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === "*" && glob[i + 1] === "*") {
            // "**/" matches zero or more directories; a trailing "**" matches anything.
            if (glob[i + 2] === "/") {
                re += "(?:.*/)?";
                i += 2;
            } else {
                re += ".*";
                i += 1;
            }
        } else if (c === "*") {
            re += "[^/]*";
        } else if (c === "?") {
            re += "[^/]";
        } else {
            re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
        }
    }
    return new RegExp(`^${re}$`);
}

function matchesAny(path, globs) {
    return globs.some((g) => globToRegExp(g).test(path));
}

/** `Key: value` trailer lines in a PR body (first occurrence wins). */
function trailer(body, key) {
    const m = new RegExp(`^${key}:[ \\t]*(\\S+)[ \\t]*$`, "m").exec(body || "");
    return m ? m[1] : null;
}

const TASK_ID = /^[a-z0-9-]+(?:\/[a-z0-9-]+)+$/;

/**
 * Decide the gate outcome.
 * @param {object} input
 *   isAgent       - PR author is the agent App
 *   body          - PR body
 *   changed       - changed paths
 *   protectedGlobs- tiers.yaml protected_from_agents
 *   loadContract  - (taskId) => {scope: string[], acceptance: [...] , lastCommit: string} | null
 * @returns {{ok: boolean, kind: "human"|"factory", reasons: string[], task?: string, goldenAreas: string[],
 *            goldenStep?: string|null, differential?: {seed: number, phrases: number}|null}}
 */
function evaluate({ isAgent, body, changed, protectedGlobs, loadContract }) {
    const task = trailer(body, "Factory-Task");
    if (!task && !isAgent) {
        return { ok: true, kind: "human", reasons: [], goldenAreas: [], goldenStep: null, differential: null };
    }
    // Factory or agent PR from here on. Fail closed and report EVERY violation: protected paths
    // are checked first and independently of the task id and the contract, so a PR is never
    // rejected for one reason while another (worse) violation goes unreported.
    const reasons = [];
    for (const path of changed) {
        if (matchesAny(path, protectedGlobs)) reasons.push(`protected path changed: ${path}`);
    }
    if (changed.length === 0) reasons.push("no changed files");
    const fail = (extra) => ({ ok: false, kind: "factory", task: task || undefined, reasons: [...reasons, ...extra], goldenAreas: [] });
    if (!task) return fail(["agent PR without Factory-Task trailer"]);
    if (!TASK_ID.test(task)) return fail([`invalid Factory-Task id ${JSON.stringify(task)}`]);
    const contract = loadContract(task);
    if (!contract) return fail([`no contract contracts/${task}.yaml on the base branch`]);

    const declared = trailer(body, "Contract-SHA");
    if (!declared) reasons.push("missing Contract-SHA trailer");
    else if (!/^[0-9a-f]{7,40}$/.test(declared) || !contract.lastCommit.startsWith(declared)) {
        reasons.push(`stale contract: PR declares ${declared}, contract is at ${contract.lastCommit}`);
    }

    const scope = Array.isArray(contract.scope) ? contract.scope : [];
    for (const path of changed) {
        if (!matchesAny(path, protectedGlobs) && !matchesAny(path, scope)) reasons.push(`out of contract scope: ${path}`);
    }

    // acceptance: - golden: { step: ENWeekdayParser, areas: [en/weekday, ...] }
    //             - differential: { phrases: 2000, seed: 42, match: chrono-node@<sha> }
    const goldenAreas = [];
    let goldenStep = null;
    let differential = null;
    for (const a of contract.acceptance || []) {
        if (a && a.golden !== undefined) {
            const g = a.golden;
            const areasOk =
                g &&
                Array.isArray(g.areas) &&
                g.areas.length > 0 &&
                g.areas.every((x) => typeof x === "string" && /^[a-z0-9_/]+$/.test(x));
            if (!areasOk || typeof g.step !== "string" || !/^[A-Za-z0-9]+$/.test(g.step)) {
                reasons.push("unsupported golden acceptance (want {step, areas})");
            } else {
                goldenStep = g.step;
                goldenAreas.push(...g.areas);
            }
        }
        if (a && a.differential !== undefined) {
            const d = a.differential;
            if (!d || !Number.isInteger(d.seed) || !Number.isInteger(d.phrases) || d.phrases < 1 || d.phrases > 20000) {
                reasons.push("unsupported differential acceptance (want {phrases, seed})");
            } else {
                differential = { seed: d.seed, phrases: d.phrases };
            }
        }
    }
    return { ok: reasons.length === 0, kind: "factory", task, reasons, goldenAreas, goldenStep, differential };
}

/**
 * Whether the change needs the full regression (auto-strict, DESIGN §9 strict gates). The same
 * classification as the controller's effective tier: the change touches an auto-strict path
 * (tiers.yaml), or its task's contract says `tier: auto-strict`, or any path in the contract's
 * scope is an auto-strict path. Applies to human PRs too. Fails closed: no auto-strict paths in
 * the policy → true.
 */
function needsFullRegression({ changed, autoStrictGlobs, contractTier, contractScope = [] }) {
    if (!Array.isArray(autoStrictGlobs) || autoStrictGlobs.length === 0) return true;
    if (contractTier === "auto-strict") return true;
    const scope = Array.isArray(contractScope) ? contractScope.filter((p) => typeof p === "string") : [];
    return [...changed, ...scope].some((p) => matchesAny(p, autoStrictGlobs));
}

// The reviewer App (sabbasi3-factory-reviewer). Anyone with checks:write can name a check run
// `factory-review`; only this App id makes it the reviewer's (same constant as the controller).
const REVIEWER_APP_ID = 5444751;
const REVIEW_CHECK_NAME = "factory-review";

/**
 * Merge-queue review gate (DESIGN §9 strict gates, `reviewer_agent`). An agent PR whose change is
 * auto-strict (`needsFullRegression`) may enter main only if a person put it in the queue, or the
 * reviewer App's latest `factory-review` check run on the PR head passed and names that head
 * (`Reviewed-Head: <sha>` as the summary's first line). "Latest" is the highest check-run id. So neither the agent nor the controller
 * App can merge an unreviewed auto-strict change. Fails closed: an unknown enqueuer counts as
 * not a person; unreadable checks count as no review.
 *   enqueuer: { type: "User" | "Bot" | ..., login } of the last AddedToMergeQueueEvent, or null.
 *   checkRuns: the REST check runs on `head` named factory-review (any app), or null if unread.
 */
function reviewGate({ isAgent, strict, head, enqueuer, checkRuns }) {
    if (!isAgent || !strict) return { ok: true, why: "review not required (not an agent auto-strict change)" };
    if (enqueuer && enqueuer.type === "User" && typeof enqueuer.login === "string" && enqueuer.login) {
        return { ok: true, why: `enqueued by a person (${enqueuer.login}): no reviewer verdict required` };
    }
    if (!/^[0-9a-f]{40}$/.test(head || "")) return { ok: false, why: "review gate: PR head unknown" };
    if (!Array.isArray(checkRuns)) return { ok: false, why: "review gate: factory-review check runs unreadable" };
    const ours = checkRuns
        .filter((c) => c && c.app && c.app.id === REVIEWER_APP_ID && c.name === REVIEW_CHECK_NAME && c.head_sha === head)
        // Newest first by check-run id (assigned in creation order): a newer queued run, whose
        // started_at may still be null, must hide an older pass.
        .sort((a, b) => (Number(b.id) || 0) - (Number(a.id) || 0));
    const latest = ours[0];
    if (!latest) return { ok: false, why: `review gate: no factory-review from the reviewer App on ${head} (enqueued by ${enqueuer ? enqueuer.login || "unknown" : "unknown"})` };
    const first = String((latest.output && latest.output.summary) || "").split("\n")[0].replace(/\r$/, "").trimEnd();
    if (latest.status !== "completed" || latest.conclusion !== "success") {
        return { ok: false, why: `review gate: latest factory-review on ${head} is ${latest.status}/${latest.conclusion}` };
    }
    if (first !== `Reviewed-Head: ${head}`) return { ok: false, why: `review gate: factory-review on ${head} doesn't name that head` };
    return { ok: true, why: `reviewer passed ${head} (check run ${latest.id})` };
}

module.exports = { globToRegExp, matchesAny, trailer, evaluate, needsFullRegression, reviewGate, REVIEWER_APP_ID };
