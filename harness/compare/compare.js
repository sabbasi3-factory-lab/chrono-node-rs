#!/usr/bin/env node
"use strict";
// Comparison harness: random phrases through chrono-node (the judge) and the Rust port.
//
//   node compare/compare.js                      # fresh random seed (local held-out run)
//   node compare/compare.js --seed 12345         # reproduce a run (CI passes its held-out seed this way)
//   node compare/compare.js --phrases 5000 --rust ../target/release/chrono-rs-json --report out.json
//
// Only phrases whose required parsers/refiners are all ported in Rust are compared; the rest are
// counted as "not yet comparable". The seed is printed AFTER the run, as the last line. A fresh
// seed (no --seed) prints:
//   factory-heldout-seed: <seed>
// A given seed (the contract's visible one, a reproduction, or CI's held-out seed) prints instead:
//   factory-comparison-seed: <seed>
// In CI the held-out seed comes from the trusted first step of the `checks` job (commit–reveal,
// see .github/workflows/ci.yml); the controller records it from there, not from this output.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

// Same process time zone as the golden data. Re-exec once if needed.
if (process.env.TZ !== "UTC") {
    const res = spawnSync(process.execPath, process.argv.slice(1), { stdio: "inherit", env: { ...process.env, TZ: "UTC" } });
    process.exit(res.status ?? 1);
}

const S = require("../lib/serialize");
const { trace } = require("../lib/trace");
const { generate } = require("./phrases");

const HARNESS = path.resolve(__dirname, "..");
const REPO = path.resolve(HARNESS, "..");

function parseArgs(argv) {
    const args = { seed: null, phrases: 2000, rust: path.join(REPO, "target/debug/chrono-rs-json"), report: null, show: 20 };
    const value = (k, v) => {
        if (v === undefined || v.startsWith("--")) throw new Error(`${k} needs a value`);
        return v;
    };
    const integer = (k, v, min, max) => {
        const n = Number(value(k, v));
        if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${k} must be an integer in [${min}, ${max}]`);
        return n;
    };
    for (let i = 0; i < argv.length; i++) {
        const [k, v] = [argv[i], argv[i + 1]];
        if (k === "--seed") (args.seed = integer(k, v, 0, 2 ** 32 - 1)), i++;
        else if (k === "--phrases") (args.phrases = integer(k, v, 1, 1000000)), i++;
        else if (k === "--rust") (args.rust = path.resolve(value(k, v))), i++;
        else if (k === "--report") (args.report = path.resolve(value(k, v))), i++;
        else if (k === "--show") (args.show = integer(k, v, 0, 100000)), i++;
        else throw new Error(`unknown argument ${k}`);
    }
    return args;
}

/** POSIX shell single-quoting. */
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function loadUpstream() {
    const built = path.join(HARNESS, ".build/chrono/index.js");
    if (!fs.existsSync(built)) throw new Error("run `npm run build:upstream` in harness/ first");
    const chronoModule = require(built);
    const chronoCore = require(path.join(HARNESS, ".build/chrono/chrono.js"));
    const { Chrono, en } = chronoModule;
    const configs = {
        "en.casual": new Chrono(en.configuration.createCasualConfiguration(false)),
        "en.strict": new Chrono(en.configuration.createConfiguration(true, false)),
        "en.GB.casual": new Chrono(en.configuration.createCasualConfiguration(true)),
        "en.GB.strict": new Chrono(en.configuration.createConfiguration(true, true)),
    };
    return { chronoCore, configs };
}

function runRust(rust, args, input) {
    const res = spawnSync(rust, args, { input, maxBuffer: 1 << 30, encoding: "utf8" });
    if (res.error) throw new Error(`cannot run ${rust}: ${res.error.message} (build it with cargo build --bin chrono-rs-json)`);
    if (res.status !== 0) throw new Error(`${rust} exited ${res.status}: ${res.stderr}`);
    return res.stdout;
}

function toUpstreamReference(reference) {
    const instant = new Date(reference.instant);
    if (reference.kind === "date") return instant;
    return { instant, timezone: reference.timezone_input ?? undefined };
}

function main(args, seed) {
    const started = Date.now();

    const { chronoCore, configs } = loadUpstream();
    const registered = JSON.parse(runRust(args.rust, ["--registered"], ""));

    const requests = generate(seed, args.phrases);
    const expected = new Map();
    const comparable = [];
    let notComparable = 0;
    const errors = [];
    for (const req of requests) {
        const chrono = configs[req.config];
        const ref = toUpstreamReference(req.reference);
        const option = { ...req.options };
        const traced = trace(chronoCore, chrono, req.text, ref, option);
        const direct = S.serializeResults(chrono.parse(req.text, toUpstreamReference(req.reference), { ...req.options }));
        const tracedOut = S.serializeResults(traced.results);
        if (JSON.stringify(direct) !== JSON.stringify(tracedOut)) {
            errors.push({ id: req.id, error: "trace differs from chrono.parse" });
            continue;
        }
        const have = new Set(registered[req.config].registered);
        if (![...traced.parsers, ...traced.refiners].every((n) => have.has(n))) {
            notComparable++;
            continue;
        }
        expected.set(req.id, { req, results: tracedOut, requires: { parsers: traced.parsers, refiners: traced.refiners } });
        comparable.push(req);
    }

    const output = runRust(args.rust, [], comparable.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const actual = new Map();
    for (const line of output.split("\n")) {
        if (!line.trim()) continue;
        const r = JSON.parse(line);
        actual.set(r.id, r);
    }

    const mismatches = [];
    let matched = 0;
    let nonEmptyMatched = 0;
    for (const [id, exp] of expected) {
        const got = actual.get(id);
        if (!got || got.error) {
            errors.push({ id, error: got ? got.error : "no output from Rust" });
            continue;
        }
        const a = JSON.stringify(S.sortKeys(exp.results));
        const b = JSON.stringify(S.sortKeys(got.results));
        if (a === b) {
            matched++;
            if (exp.results.length > 0) nonEmptyMatched++;
        } else {
            mismatches.push({ request: exp.req, requires: exp.requires, expected: exp.results, actual: got.results });
        }
    }

    const summary = {
        phrases: requests.length,
        comparable: comparable.length,
        not_yet_comparable: notComparable,
        matched,
        matched_with_results: nonEmptyMatched,
        mismatched: mismatches.length,
        errors: errors.length,
        seconds: Math.round((Date.now() - started) / 100) / 10,
    };
    console.log("comparison with chrono-node:", JSON.stringify(summary));
    for (const m of mismatches.slice(0, args.show)) {
        console.log(`\nMISMATCH id=${m.request.id} config=${m.request.config} text=${JSON.stringify(m.request.text)}`);
        console.log(`  reference ${JSON.stringify(m.request.reference)} options ${JSON.stringify(m.request.options)}`);
        console.log(`  expected ${JSON.stringify(m.expected)}`);
        console.log(`  actual   ${JSON.stringify(m.actual)}`);
    }
    for (const e of errors.slice(0, args.show)) console.log(`ERROR id=${e.id}: ${e.error}`);
    if (args.report) {
        fs.writeFileSync(args.report, JSON.stringify({ seed, summary, mismatches, errors }, null, 2) + "\n");
    }
    // If no comparable phrase has a non-empty expected result, nothing real was checked (e.g. the
    // Rust CLI registers nothing): fail instead of passing vacuously.
    const vacuous = ![...expected.values()].some((e) => e.results.length > 0);
    if (vacuous) console.log("ERROR: no comparable phrase with a non-empty result (is the Rust CLI registering steps?)");
    if (mismatches.length > 0 || errors.length > 0 || vacuous) {
        console.log(`\nreproduce: cd ${shq(HARNESS)} && node compare/compare.js --seed ${seed} --phrases ${args.phrases} --rust ${shq(args.rust)}`);
    }
    return mismatches.length > 0 || errors.length > 0 || vacuous ? 1 : 0;
}

let args;
try {
    args = parseArgs(process.argv.slice(2));
} catch (e) {
    console.error(e.message);
    process.exit(2);
}
const seed = args.seed ?? crypto.randomInt(0, 2 ** 32);
let code = 1;
try {
    code = main(args, seed);
} catch (e) {
    console.error(e && e.stack ? e.stack : e);
} finally {
    // Printed last, after the run (even if it crashed): the held-out seed is never shown before
    // results exist, and every run can be reproduced.
    console.log(args.seed === null ? `factory-heldout-seed: ${seed}` : `factory-comparison-seed: ${seed}`);
}
// Not process.exit(): let piped stdout (including the seed line) drain before exiting.
process.exitCode = code;
