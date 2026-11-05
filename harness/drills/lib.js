"use strict";
// Pure helpers of the fire drills (drills.js does the I/O).

const pass = (summary) => ({ result: "pass", summary });
const fail = (summary, detail = "") => ({ result: "fail", summary, detail: String(detail) });

/** A golden file with one planted wrong expectation: the first case with a result gets index + 1. */
function plantGoldenMismatch(text) {
    const data = JSON.parse(text);
    const c = data.cases.find((x) => Array.isArray(x.results) && x.results.length > 0);
    if (!c) throw new Error("no case with a result to plant into");
    c.results[0].index += 1;
    return JSON.stringify(data, null, 2) + "\n";
}

/** A fresh comparison seed per day (32-bit FNV-1a of the UTC date), printed in the result. */
function seedFor(date) {
    let h = 0x811c9dc5;
    for (const ch of Buffer.from(`drill:${date.toISOString().slice(0, 10)}`)) h = Math.imul(h ^ ch, 0x01000193) >>> 0;
    return h;
}

/** compare.js's summary line, or null. */
function compareSummary(out) {
    const m = /comparison with chrono-node: (\{.*\})/.exec(out);
    return m ? JSON.parse(m[1]) : null;
}

/** A plain port contract (no unit or fix acceptance) to drill the scope gate with: the first by id. */
function pickContract(ids, load) {
    for (const id of [...ids].sort()) {
        const c = load(id);
        if (c && Array.isArray(c.scope) && c.scope.length === 1 && !(c.acceptance || []).some((a) => a && (a.unit || a.fix))) return id;
    }
    throw new Error("no plain contract to drill with");
}

/** The scope-gate cases: one control that must pass, three faults that must be rejected with their reason. */
function scopeCases({ task, contract }) {
    const body = (sha) => `Implements ${task}.\n\nFactory-Task: ${task}\nContract-SHA: ${sha}\n`;
    const own = contract.scope[0];
    return [
        { name: "control: in scope", body: body(contract.lastCommit), changed: [own], ok: true, reasons: [] },
        { name: "out of scope", body: body(contract.lastCommit), changed: [own, "src/core/chrono.rs"], ok: false, reasons: [/out of contract scope: src\/core\/chrono\.rs/] },
        { name: "protected path", body: body(contract.lastCommit), changed: [own, ".github/workflows/ci.yml"], ok: false, reasons: [/protected path changed: \.github\/workflows\/ci\.yml/] },
        { name: "stale contract", body: body("0000000"), changed: [own], ok: false, reasons: [/stale contract/] },
    ];
}

/** Decision reasons in the controller's printed events, counted. */
function controllerReasons(out) {
    const counts = {};
    for (const m of out.matchAll(/"reason":"([a-z_]+)"/g)) counts[m[1]] = (counts[m[1]] || 0) + 1;
    return counts;
}

const sortByPath = (files) => [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

/** A copy of the audit files with one event's payload changed (still valid JSON): its sha no longer matches. */
function tamperPayload(files) {
    const sorted = sortByPath(files);
    const f = sorted[Math.floor(sorted.length / 2)];
    const lines = f.content.slice(0, -1).split("\n");
    const i = Math.floor(lines.length / 2);
    const before = lines[i];
    lines[i] = before.includes('"dry_run":true') ? before.replace('"dry_run":true', '"dry_run":false') : before.replace(/"id":"([0-9a-f])/, (m, c) => `"id":"${c === "a" ? "b" : "a"}`);
    if (lines[i] === before) throw new Error("nothing to tamper with");
    return sorted.map((x) => (x === f ? { ...x, content: lines.join("\n") + "\n" } : x));
}

/** A copy of the audit files truncated to the first half of its events (anchors recorded more). */
function truncateHalf(files) {
    const sorted = sortByPath(files);
    const total = sorted.reduce((n, f) => n + f.content.slice(0, -1).split("\n").length, 0);
    let keep = Math.floor(total / 2);
    const out = [];
    for (const f of sorted) {
        if (keep <= 0) break;
        const lines = f.content.slice(0, -1).split("\n").slice(0, keep);
        keep -= lines.length;
        out.push({ ...f, content: lines.join("\n") + "\n" });
    }
    return out;
}

/**
 * Whether a scheduled slot runs the drills: about once a week at a random time (4 slots a day), and
 * always when the last passing run is more than 7 days old (or unknown).
 */
function shouldRun({ now, lastPassAt, random, slotsPerDay = 4 }) {
    if (!lastPassAt || now - Date.parse(lastPassAt) > 7 * 86_400_000) return { run: true, why: "no passing drill run in 7 days" };
    if (random < 1 / (7 * slotsPerDay)) return { run: true, why: "this week's random slot" };
    return { run: false, why: "not this slot" };
}

/**
 * The onboarding decision's inputs (onboard.js next files), for one generated locale `code`: a
 * control with complete data (min_sample merged first-try tasks, every run recorded) and faults
 * that must never onboard. `ok` cases must decide "onboard"; the rest must not.
 */
function onboardCases(policy, code) {
    const n = Math.max(1, policy.stop.min_sample ?? 5);
    const tasks = Array.from({ length: n }, (_, i) => `${code}/drill-step-${i}`);
    const at = (i) => `2026-01-01T00:${String(i).padStart(2, "0")}:00Z`;
    const ledgerRuns = tasks.map((t, i) => ({ run_id: 1000 + i, workflow: "implement", title: `Implement ${t} #${i + 1} attempt 1`, conclusion: "success", created_at: at(i) }));
    const merged = tasks.map((t) => ({ title: `[factory] ${t}: port it` }));
    const outcomes = { runs: tasks.map((t, i) => ({ run_id: 1000 + i, task: t, workflow: "implement", aic: 1, created_at: at(i), items: [{ type: "create_pull_request", outcome_status: "accepted", zero_touch: true }] })) };
    const files = { outcomes: JSON.stringify(outcomes), issues: "[]", prs: "[]", runs: JSON.stringify(ledgerRuns), merged: JSON.stringify(merged) };
    return [
        { name: "control: complete data", files, ok: true },
        { name: "outcomes.json without the locale's runs (#317)", files: { ...files, outcomes: JSON.stringify({ runs: [] }) }, ok: false },
        { name: "outcomes.json missing one run", files: { ...files, outcomes: JSON.stringify({ runs: outcomes.runs.slice(1) }) }, ok: false },
        { name: "outcomes.json empty", files: { ...files, outcomes: "" }, ok: false },
        { name: "issues unreadable (empty file)", files: { ...files, issues: "" }, ok: false },
        { name: "run ledger unreadable", files: { ...files, runs: "" }, ok: false },
        { name: "spend at the budget", files: { ...files, outcomes: JSON.stringify({ runs: outcomes.runs.map((r, i) => (i === 0 ? { ...r, aic: policy.stop.budget_aic } : r)) }) }, ok: false },
    ];
}

module.exports = { pass, fail, onboardCases, plantGoldenMismatch, seedFor, compareSummary, pickContract, scopeCases, controllerReasons, tamperPayload, truncateHalf, shouldRun };
