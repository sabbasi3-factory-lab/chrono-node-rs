#!/usr/bin/env node
"use strict";
// Golden frontier: per-step verification of golden cases, and the completion check. Plain code, no AI.
//
// The whole-crate golden suite checks a case only once every step it needs is ported, so a step can
// merge with a defect that only a pending case exposes (#397: the ru casual-date parser looked up the
// whole match; golden ru/casual#22 also needs the date-range refiner, so it stayed pending until that
// refiner's agent hit it and couldn't fix it). This compares each ported step's OWN output with
// chrono-node's, step by step, on every golden case:
//   - parsers: each parser's raw results (independent of the other steps);
//   - refiners, in order: each ported refiner run ALONE on chrono-node's input for its slot
//     (`chrono-rs-json --trace` with `isolate`), so it's checked even while an earlier step is
//     unported; without isolated output, the chained results while every earlier step is ported.
// The earliest step whose output differs is blamed: it had the same input as chrono-node's. A case
// whose steps are all ported and all match alone but whose end results differ is blamed on "chain"
// (state the JSON shape doesn't carry between steps), for a person to look at.
//
//   node golden/frontier.js --rust BIN [--report F] [--complete]
//     fails if a ported step diverges on any case (pending or checked), naming the step and its task;
//     --complete: also fails if a generated locale whose task steps are all ported still has pending
//     cases (the language can't count as done), listing them;
//     --all: also fails on any pending case at all (release.yml: a release ships only whole languages).
//
// Cases recorded with no reference (kind "none") are traced with their resolved instant as a Date
// reference; a case whose chrono-node trace doesn't reproduce its recorded results is an error.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const S = require("../lib/serialize");
const { loadUpstream, toUpstreamReference } = require("../lib/upstream");

const REPO = path.resolve(__dirname, "../..");

/** Every golden case (fix cases excluded: they're pending on purpose until their fix lands). */
function goldenCases(dir = path.join(REPO, "tests/golden")) {
    const out = [];
    for (const group of fs.readdirSync(dir).sort()) {
        const g = path.join(dir, group);
        if (group === "fixes" || !fs.statSync(g).isDirectory()) continue;
        for (const f of fs.readdirSync(g).filter((x) => x.endsWith(".json")).sort()) {
            const data = JSON.parse(fs.readFileSync(path.join(g, f), "utf8"));
            for (const c of data.cases || []) out.push({ group, area: `${group}/${f.slice(0, -5)}`, ...c });
        }
    }
    return out;
}

/** chrono-node's per-step outputs for one request (same shape as `chrono-rs-json --trace`). */
function jsTrace(chronoCore, chrono, text, ref, option) {
    const { Chrono, ParsingContext } = chronoCore;
    const context = new ParsingContext(text, ref, option);
    const parsers = [];
    let results = [];
    for (const parser of chrono.parsers) {
        const found = Chrono.executeParser(context, parser);
        parsers.push({ step: S.stepName(parser), results: S.serializeResults(found) });
        results = results.concat(found);
    }
    results.sort((a, b) => a.index - b.index);
    const refiners = [];
    for (const refiner of chrono.refiners) {
        const input = S.serializeResults(results);
        results = refiner.refine(context, results);
        refiners.push({ step: S.stepName(refiner), input, results: S.serializeResults(results) });
    }
    return { parsers, refiners, results: S.serializeResults(results) };
}

const same = (a, b) => JSON.stringify(S.sortKeys(a)) === JSON.stringify(S.sortKeys(b));

/**
 * The earliest ported step whose output differs from chrono-node's, or null. Pure.
 *   js:   {parsers: [{step, results}], refiners: [{step, results}]}, every configuration slot
 *   rust: the same for the ported slots only (`chrono-rs-json --trace`; unported slots are skipped)
 * Steps are matched by name and occurrence (a configuration may list a refiner twice).
 */
function blame(js, rust) {
    const take = (list) => {
        const seen = new Map();
        return list.map((s) => {
            const n = seen.get(s.step) || 0;
            seen.set(s.step, n + 1);
            return { ...s, key: `${s.step}#${n}` };
        });
    };
    const rp = new Map(take(rust.parsers).map((s) => [s.key, s]));
    let allParsers = true;
    for (const s of take(js.parsers)) {
        const r = rp.get(s.key);
        if (!r) {
            allParsers = false;
            continue;
        }
        if (!same(s.results, r.results)) return { step: s.step, kind: "parser", expected: s.results, actual: r.results };
    }
    if (rust.isolated) {
        const iso = new Map(rust.isolated.filter((s) => s.results).map((s) => [`${s.step}#${s.occurrence}`, s]));
        for (const s of take(js.refiners)) {
            const r = iso.get(s.key);
            if (r && !same(s.results, r.results)) return { step: s.step, kind: "refiner", expected: s.results, actual: r.results };
        }
        if (allParsers && rust.refiners.length === js.refiners.length && rust.results && !same(js.results, rust.results)) {
            return { step: "chain", kind: "chain", expected: js.results, actual: rust.results };
        }
        return null;
    }
    if (!allParsers) return null;
    const rr = new Map(take(rust.refiners).map((s) => [s.key, s]));
    for (const s of take(js.refiners)) {
        const r = rr.get(s.key);
        if (!r) return null; // unported: later refiners see other inputs
        if (!same(s.results, r.results)) return { step: s.step, kind: "refiner", expected: s.results, actual: r.results };
    }
    return null;
}

/** The `isolate` list for a Rust trace request: every refiner slot with chrono-node's input. Pure. */
function isolateRequests(js) {
    const seen = new Map();
    return js.refiners.map((s) => {
        const occurrence = seen.get(s.step) || 0;
        seen.set(s.step, occurrence + 1);
        return { step: s.step, occurrence, input: s.input };
    });
}

/** Task ids by upstream step name, from the contracts on this checkout. */
function tasksByStep() {
    const out = new Map();
    const dir = path.join(REPO, "contracts");
    for (const loc of fs.readdirSync(dir)) {
        const d = path.join(dir, loc);
        if (!fs.statSync(d).isDirectory()) continue;
        for (const f of fs.readdirSync(d).filter((x) => x.endsWith(".yaml"))) {
            const m = /^upstream_class: (\S+)$/m.exec(fs.readFileSync(path.join(d, f), "utf8"));
            if (m && !out.has(m[1])) out.set(m[1], `${loc}/${f.slice(0, -5)}`);
        }
    }
    return out;
}

/** Generated locales whose task steps are all ported: {module: [step]} from the taskmap fragments. */
function completeLocales(registered) {
    const YAML = require("yaml");
    const dir = path.join(REPO, "scripts/seed-backlog/taskmap.d");
    const all = new Set(Object.values(registered).flatMap((c) => c.registered));
    const out = [];
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.endsWith(".yaml")).sort() : []) {
        const frag = YAML.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        const steps = (frag.tasks || []).filter((t) => t.step).map((t) => t.step);
        if (steps.length > 0 && steps.every((s) => all.has(s))) out.push(frag.locale);
    }
    return out;
}

function run(rust, args, input) {
    const res = spawnSync(rust, args, { input, maxBuffer: 1 << 30, encoding: "utf8" });
    if (res.error || res.status !== 0) throw new Error(`${rust} ${args.join(" ")} failed: ${res.error ? res.error.message : res.stderr}`);
    return res.stdout;
}

function main() {
    const opt = (n) => {
        const i = process.argv.indexOf(n);
        return i > 0 ? process.argv[i + 1] : null;
    };
    const rust = opt("--rust") || path.join(REPO, "target/debug/chrono-rs-json");
    const { chronoCore, configs } = loadUpstream();
    const registered = JSON.parse(run(rust, ["--registered"], ""));
    const cases = goldenCases().filter((c) => configs[c.config] && registered[c.config]);
    const traces = cases.map((c) => {
        const ref = c.reference.kind === "none" ? new Date(c.reference.instant) : toUpstreamReference(c.reference);
        return jsTrace(chronoCore, configs[c.config], c.text, ref, { ...(c.options || {}) });
    });
    const requests = cases.map((c, i) => ({ id: i, text: c.text, config: c.config, reference: c.reference, options: c.options || {}, isolate: isolateRequests(traces[i]) }));
    const out = new Map();
    for (const line of run(rust, ["--trace"], requests.map((r) => JSON.stringify(r)).join("\n") + "\n").split("\n")) if (line.trim()) out.set(JSON.parse(line).id, JSON.parse(line));
    const tasks = tasksByStep();
    const divergences = [];
    const errors = [];
    const pendingBy = new Map();
    let pending = 0;
    for (const [i, c] of cases.entries()) {
        const have = new Set(registered[c.config].registered);
        const requires = [...(c.requires.parsers || []), ...(c.requires.refiners || [])];
        const isPending = !requires.every((s) => have.has(s));
        if (isPending) {
            pending++;
            pendingBy.set(c.group, [...(pendingBy.get(c.group) || []), { id: c.id, missing: requires.filter((s) => !have.has(s)) }]);
        }
        const js = traces[i];
        if (!same(js.results, c.results)) {
            errors.push(`${c.id}: chrono-node's trace doesn't reproduce the recorded results`);
            continue;
        }
        const r = out.get(i);
        if (!r || r.error) {
            errors.push(`${c.id}: ${r ? r.error : "no output from Rust"}`);
            continue;
        }
        for (const x of r.isolated || []) if (x.error && !/isn't ported$/.test(x.error)) errors.push(`${c.id}: isolating ${x.step}: ${x.error}`);
        const b = blame(js, r);
        if (b) divergences.push({ id: c.id, area: c.area, config: c.config, text: c.text, pending: isPending, task: tasks.get(b.step) || null, ...b });
    }
    const complete = completeLocales(registered);
    const incomplete = complete.filter((m) => (pendingBy.get(m) || []).length > 0).map((m) => ({ locale: m, pending: pendingBy.get(m) }));
    const lines = [`golden frontier: ${cases.length} cases (${pending} pending), ${divergences.length} with a diverging ported step, ${errors.length} errors`];
    for (const d of divergences.slice(0, 30)) lines.push(`- ${d.id} ${JSON.stringify(d.text)} (${d.config}${d.pending ? ", pending" : ""}): ${d.kind} ${d.step} differs from chrono-node${d.task ? ` (task ${d.task})` : ""}\n    expected ${JSON.stringify(d.expected)}\n    actual   ${JSON.stringify(d.actual)}`);
    for (const e of errors.slice(0, 30)) lines.push(`- error: ${e}`);
    if (process.argv.includes("--complete")) {
        lines.push(`languages with every task step ported: ${complete.join(", ") || "none"}`);
        for (const x of incomplete) lines.push(`- ${x.locale}: ${x.pending.length} case(s) still pending, e.g. ${x.pending.slice(0, 5).map((p) => `${p.id} (needs ${p.missing.join(", ")})`).join("; ")}`);
    }
    if (opt("--report")) fs.writeFileSync(opt("--report"), JSON.stringify({ cases: cases.length, pending, divergences, errors, complete, incomplete }, null, 1) + "\n");
    if (process.argv.includes("--all")) for (const [g, list] of pendingBy) lines.push(`- pending in ${g}: ${list.length} (e.g. ${list.slice(0, 3).map((p) => `${p.id} needs ${p.missing.join(", ")}`).join("; ")})`);
    const failed = divergences.length > 0 || errors.length > 0 || (process.argv.includes("--complete") && incomplete.length > 0) || (process.argv.includes("--all") && pending > 0);
    console.log(lines.join("\n"));
    process.exitCode = failed ? 1 : 0;
}

if (require.main === module) {
    try {
        main();
    } catch (e) {
        console.error(e.message);
        process.exitCode = 1;
    }
}

module.exports = { blame, isolateRequests, jsTrace, goldenCases, completeLocales };
