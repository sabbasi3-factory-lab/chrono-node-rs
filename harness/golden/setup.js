"use strict";
// Runs inside every upstream test file (jest setupFilesAfterEnv). It records each call to
// Chrono.prototype.parse: the input, the reference, the options, and what chrono-node returned.
// It also re-runs the call step by step to find which parsers produced results and which
// refiners changed them ("requires"), so the Rust side only checks cases it can handle.
const fs = require("fs");
const path = require("path");
const S = require("../lib/serialize");

const UPSTREAM = path.resolve(__dirname, "../../upstream");
const RAW_DIR = process.env.GOLDEN_RAW_DIR;
const DEFAULT_REFERENCE = process.env.GOLDEN_DEFAULT_REFERENCE;
const SYSTEM_TIMEZONE = process.env.TZ;

if (!RAW_DIR || !DEFAULT_REFERENCE) throw new Error("run through harness/golden/generate.js");
if (SYSTEM_TIMEZONE !== "UTC" || new Date(0).getTimezoneOffset() !== 0) {
    throw new Error("golden generation must run with TZ=UTC");
}

// Freeze "now", so calls without a reference date are deterministic. Only Date is faked.
jest.useFakeTimers({
    now: new Date(DEFAULT_REFERENCE),
    doNotFake: [
        "hrtime",
        "nextTick",
        "performance",
        "queueMicrotask",
        "requestAnimationFrame",
        "cancelAnimationFrame",
        "requestIdleCallback",
        "cancelIdleCallback",
        "setImmediate",
        "clearImmediate",
        "setInterval",
        "clearInterval",
        "setTimeout",
        "clearTimeout",
    ],
});

const { Chrono, ParsingContext } = require(path.join(UPSTREAM, "src/chrono"));
const en = require(path.join(UPSTREAM, "src/locales/en"));
const de = require(path.join(UPSTREAM, "src/locales/de"));
const fr = require(path.join(UPSTREAM, "src/locales/fr"));
const sv = require(path.join(UPSTREAM, "src/locales/sv"));
const pt = require(path.join(UPSTREAM, "src/locales/pt"));
const es = require(path.join(UPSTREAM, "src/locales/es"));
const ja = require(path.join(UPSTREAM, "src/locales/ja"));
S.registerUpstreamAliases((p) => require(path.join(UPSTREAM, "src", p)));

// Named configurations the Rust crate reproduces. Anything else is "custom" and skipped.
const KNOWN_CONFIGS = new Map();
function addKnown(name, chrono) {
    const fingerprint = JSON.stringify(S.describeConfiguration(chrono));
    if (KNOWN_CONFIGS.has(fingerprint)) throw new Error(`${name} has the same steps as ${KNOWN_CONFIGS.get(fingerprint)}`);
    KNOWN_CONFIGS.set(fingerprint, name);
}
addKnown("en.casual", new Chrono(en.configuration.createCasualConfiguration(false)));
addKnown("en.strict", new Chrono(en.configuration.createConfiguration(true, false)));
addKnown("en.GB.casual", new Chrono(en.configuration.createCasualConfiguration(true)));
addKnown("en.GB.strict", new Chrono(en.configuration.createConfiguration(true, true)));
addKnown("de.casual", new Chrono(de.createCasualConfiguration()));
addKnown("de.strict", new Chrono(de.createConfiguration(true)));
addKnown("fr.casual", new Chrono(fr.createCasualConfiguration()));
addKnown("fr.strict", new Chrono(fr.createConfiguration(true)));
addKnown("sv.casual", new Chrono(sv.createCasualConfiguration()));
addKnown("sv.strict", new Chrono(sv.createConfiguration(true)));
addKnown("pt.casual", new Chrono(pt.createCasualConfiguration()));
addKnown("pt.strict", new Chrono(pt.createConfiguration(true)));
addKnown("es.casual", new Chrono(es.createCasualConfiguration()));
addKnown("es.strict", new Chrono(es.createConfiguration(true)));
addKnown("ja.casual", new Chrono(ja.createCasualConfiguration()));
addKnown("ja.strict", new Chrono(ja.createConfiguration(true)));
// Generated locales (lib/locales.js): the locale module's exported Chrono instances, as its tests use them.
for (const locale of require("../lib/locales").generatedLocales()) {
    const L = require(path.join(UPSTREAM, "src", locale.upstream));
    for (const [name, exported] of Object.entries(locale.configs)) {
        if (!(L[exported] instanceof Chrono)) throw new Error(`${locale.upstream} exports no Chrono ${exported}`);
        addKnown(name, L[exported]);
    }
}

function configName(chrono) {
    return KNOWN_CONFIGS.get(JSON.stringify(S.describeConfiguration(chrono))) ?? null;
}

const snapshot = (results) => JSON.stringify(S.serializeResults(results));

/** Same steps as Chrono.prototype.parse, but notes which parsers fired and which refiners changed results. */
function trace(chrono, text, ref, option) {
    const context = new ParsingContext(text, ref, option);
    const parsers = new Set();
    const refiners = new Set();
    let results = [];
    for (const parser of chrono.parsers) {
        const found = Chrono.executeParser(context, parser);
        if (found.length > 0) parsers.add(S.stepName(parser));
        results = results.concat(found);
    }
    results.sort((a, b) => a.index - b.index);
    for (const refiner of chrono.refiners) {
        const before = snapshot(results);
        results = refiner.refine(context, results);
        if (snapshot(results) !== before) refiners.add(S.stepName(refiner));
    }
    return { results, parsers: [...parsers].sort(), refiners: [...refiners].sort() };
}

const cases = [];
const skipped = [];
const errors = [];
let depth = 0;

function record(chrono, text, ref, option, results) {
    const state = expect.getState();
    const where = state.currentTestName ?? null;
    const config = configName(chrono);
    if (config === null) {
        skipped.push({ reason: "custom-configuration", text, upstream_test: where });
        return;
    }
    const options = S.serializeOptions(option);
    if (options === null) {
        skipped.push({ reason: "options-not-json", text, upstream_test: where });
        return;
    }
    const context = new ParsingContext(text, ref, option);
    const output = S.serializeResults(results);
    const traced = trace(chrono, text, ref, option);
    if (JSON.stringify(S.serializeResults(traced.results)) !== JSON.stringify(output)) {
        errors.push({ reason: "trace-mismatch", text, upstream_test: where });
        return;
    }
    cases.push({
        text,
        config,
        reference: S.serializeReference(ref, context.reference),
        system_timezone: SYSTEM_TIMEZONE,
        options,
        requires: { parsers: traced.parsers, refiners: traced.refiners },
        results: output,
        upstream_test: where,
    });
}

const originalParse = Chrono.prototype.parse;
Chrono.prototype.parse = function (text, ref, option) {
    const results = originalParse.call(this, text, ref, option);
    if (depth === 0) {
        depth++;
        try {
            record(this, text, ref, option, results);
        } catch (e) {
            errors.push({ reason: "record-failed", text, error: String(e && e.message) });
        } finally {
            depth--;
        }
    }
    return results;
};

afterAll(() => {
    const testPath = expect.getState().testPath;
    const source = path.relative(UPSTREAM, testPath).split(path.sep).join("/");
    const file = path.join(RAW_DIR, source.replace(/[\/]/g, "__") + ".json");
    fs.writeFileSync(file, JSON.stringify({ source, cases, skipped, errors }));
    // The same in every test file; the generator copies it to tests/golden/configurations.json.
    const configurations = {};
    for (const [fingerprint, name] of KNOWN_CONFIGS) configurations[name] = JSON.parse(fingerprint);
    fs.writeFileSync(path.join(RAW_DIR, "..configurations"), JSON.stringify(configurations));
});
