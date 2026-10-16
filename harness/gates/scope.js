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

module.exports = { globToRegExp, matchesAny, trailer, evaluate };
