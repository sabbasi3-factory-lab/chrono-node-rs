#!/usr/bin/env node
"use strict";
// Language onboarding generator. Deterministic; no AI. Replaces the hand-written per-language
// setup (the scaffold, golden and contracts PRs of the pilot and wave 1).
//
//   node onboard/onboard.js add <code>   onboard one upstream locale (fi, it, zh-hans, ...)
//   node onboard/onboard.js check        re-render every generated locale's files; fail on any difference
//   node onboard/onboard.js candidates   upstream locales not onboarded yet, one per line
//   node onboard/onboard.js next ...     the scheduled pipeline's decision (see next() and lib.nextLanguage)
//
// `add` writes, all from the pinned chrono-node in upstream/ (built: npm run build:upstream):
//   src/locales/<module>/locale.json            the manifest (lib/locales.js); the other tools read it
//   tests/golden/<module>/*.json, index.json,   the golden generator, now including the locale's tests
//     configurations.json
//   src/locales/<module>/mod.rs, configuration.rs   the configurations' slots, from configurations.json
//   scripts/seed-backlog/taskmap.d/<module>.yaml    one task per locale step, one support task per
//                                                   shared file (constants.ts, a locale base class)
//   contracts/<code>/*.yaml                     the seed script, from the task map fragment
// What needs judgement is not generated: porting constants and every step is agent work, gated by
// golden cases (steps) and by unit cases recorded from chrono-node here (constants).
// Fails closed: a locale whose configurations use a step that's neither one of its own files nor
// already in the task map is refused, with the reason.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const YAML = require("yaml");
const LOCALES = require("../lib/locales");
const lib = require("./lib");

const HARNESS = path.resolve(__dirname, "..");
const REPO = path.resolve(HARNESS, "..");
const BUILD = path.join(HARNESS, ".build/chrono");

const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

function requireBuild() {
    if (!fs.existsSync(path.join(BUILD, "index.js"))) throw new Error("run `npm run build:upstream` in harness/ first");
}

/** Upstream locale codes, from upstream/src/locales (zh has hans/hant). */
function upstreamCodes() {
    const dir = path.join(REPO, "upstream/src/locales");
    const out = [];
    for (const d of fs.readdirSync(dir).sort()) {
        if (!fs.statSync(path.join(dir, d)).isDirectory()) continue;
        if (fs.existsSync(path.join(dir, d, "parsers"))) out.push(d);
        for (const sub of fs.readdirSync(path.join(dir, d)).sort()) {
            if (/^[a-z]{4}$/.test(sub) && fs.existsSync(path.join(dir, d, sub, "parsers"))) out.push(`${d}-${sub}`);
        }
    }
    return out;
}

function candidates() {
    const have = new Set([...LOCALES.BASE_GROUPS, ...LOCALES.generatedLocales(REPO).map((l) => l.module)]);
    return upstreamCodes().filter((c) => !have.has(c.replace("-", "_")));
}

/** The locale's golden cases from upstream's tests (not its generated coverage cases). */
function upstreamCases(module) {
    const dir = path.join(REPO, "tests/golden", module);
    if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "coverage.json").sort()) {
        out.push(...JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).cases);
    }
    return out;
}

const goldenTexts = (module) => [...new Set(upstreamCases(module).map((c) => c.text))].sort();

const COVERAGE_PER_STEP = 3;
const COVERAGE_SEARCH = 20000;

/**
 * Coverage requests for the locale's steps that no upstream test exercises: the first
 * COVERAGE_PER_STEP requests of a fixed phrase stream (the comparison's golden-text phrases, seeded
 * by the module name) whose chrono-node trace needs the step. null if every step is covered.
 */
function coverageInput(manifest, configs, fragment) {
    const S = require("../lib/serialize");
    const { trace } = require("../lib/trace");
    const phrases = require("../compare/phrases");
    const covered = new Set(upstreamCases(manifest.module).flatMap((c) => [...c.requires.parsers, ...c.requires.refiners]));
    const missing = fragment.tasks.filter((t) => t.step && !covered.has(t.step)).map((t) => t.step).sort();
    if (missing.length === 0) return null;
    S.registerUpstreamAliases((p) => require(path.join(BUILD, p)));
    const chronoModule = require(path.join(BUILD, "chrono"));
    const L = require(path.join(BUILD, manifest.upstream));
    const g = { module: manifest.module, configs: Object.keys(configs).sort(), texts: goldenTexts(manifest.module) };
    const r = phrases.prng(phrases.fnv1a(`coverage:${manifest.module}`));
    const found = new Map(missing.map((s) => [s, []]));
    for (let i = 0; i < COVERAGE_SEARCH && [...found.values()].some((l) => l.length < COVERAGE_PER_STEP); i++) {
        const { id, ...req } = phrases.goldenTextRequest(r, g, i);
        const ref = req.reference.kind === "date" ? new Date(req.reference.instant) : { instant: new Date(req.reference.instant), timezone: req.reference.timezone_input ?? undefined };
        const t = trace(chronoModule, L[manifest.configs[req.config]], req.text, ref, { ...req.options });
        for (const step of [...t.parsers, ...t.refiners]) {
            const list = found.get(step);
            if (list && list.length < COVERAGE_PER_STEP && !list.some((x) => x.text === req.text && x.config === req.config)) list.push({ step, ...req });
        }
    }
    const empty = [...found].filter(([, l]) => l.length === 0).map(([s]) => s);
    if (empty.length > 0) throw new Error(`cannot onboard ${manifest.code}: no upstream test and no generated phrase exercises ${empty.join(", ")} (a hand decision)`);
    return { generator: lib.GENERATOR, module: manifest.module, requests: [...found.values()].flat() };
}

const renderCoverage = (input) => JSON.stringify(input, null, 2) + "\n";

/** Everything the generator renders for one locale, from its manifest and the current inputs. */
function render(manifest) {
    requireBuild();
    const configurations = JSON.parse(read("tests/golden/configurations.json")).configurations;
    const configs = {};
    for (const name of Object.keys(manifest.configs)) {
        if (!configurations[name]) throw new Error(`${name} is not in tests/golden/configurations.json (run the golden generator)`);
        configs[name] = configurations[name];
    }
    const upstreamSrc = path.join(REPO, "upstream/src");
    const constantsFile = path.join(upstreamSrc, manifest.upstream, "constants.ts");
    const constants = fs.existsSync(constantsFile)
        ? { source: fs.readFileSync(constantsFile, "utf8"), module: require(path.join(BUILD, manifest.upstream, "constants")) }
        : null;
    const localeFiles = lib.listLocaleFiles(upstreamSrc, manifest.upstream);
    const fragment = lib.taskmapFragment({
        manifest,
        configs,
        baseTaskmap: YAML.parse(read("scripts/seed-backlog/taskmap.yaml")),
        localeFiles,
        constants,
        goldenTexts: goldenTexts(manifest.module),
    });
    const coverage = coverageInput(manifest, configs, fragment);
    return new Map([
        ...(coverage ? [[`harness/golden/coverage/${manifest.module}.json`, renderCoverage(coverage)]] : []),
        [`src/locales/${manifest.module}/${LOCALES.MANIFEST}`, lib.renderManifest(manifest)],
        [`src/locales/${manifest.module}/mod.rs`, lib.renderModRs(manifest)],
        [`src/locales/${manifest.module}/configuration.rs`, lib.renderConfigurationRs(manifest, configs)],
        [`scripts/seed-backlog/taskmap.d/${manifest.module}.yaml`, lib.renderFragment(fragment)],
    ]);
}

function run(cmd, args, cwd) {
    const res = spawnSync(cmd, args, { cwd, stdio: "inherit" });
    if (res.status !== 0) throw new Error(`${path.basename(args[0])} ${args.slice(1).join(" ")} failed (exit ${res.status})`);
}

function add(code) {
    if (!upstreamCodes().includes(code)) throw new Error(`${code}: no such upstream locale (have ${upstreamCodes().join(", ")})`);
    if (!candidates().includes(code)) throw new Error(`${code} is already onboarded`);
    requireBuild();
    const L = require(path.join(BUILD, `locales/${code.replace("-", "/")}`));
    const manifest = lib.manifestFor(code, Object.keys(L));
    const dir = path.join(REPO, "src/locales", manifest.module);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, LOCALES.MANIFEST), lib.renderManifest(manifest));
    try {
        run(process.execPath, [path.join(HARNESS, "golden/generate.js")], HARNESS);
        const files = render(manifest);
        for (const [rel, text] of files) {
            fs.mkdirSync(path.dirname(path.join(REPO, rel)), { recursive: true });
            fs.writeFileSync(path.join(REPO, rel), text);
        }
        // Coverage requests are recorded like any golden case; the task map then counts them.
        if ([...files.keys()].some((f) => f.startsWith("harness/golden/coverage/"))) {
            run(process.execPath, [path.join(HARNESS, "golden/generate.js")], HARNESS);
            for (const [rel, text] of render(manifest)) fs.writeFileSync(path.join(REPO, rel), text);
        }
        run(process.execPath, [path.join(REPO, "scripts/seed-backlog/seed.js"), "contracts"], path.join(REPO, "scripts/seed-backlog"));
    } catch (e) {
        console.error(`onboarding ${code} failed. Undo: git checkout -- tests/golden contracts && git clean -fd src/locales/${manifest.module} tests/golden scripts/seed-backlog/taskmap.d contracts`);
        throw e;
    }
    console.log(`onboarded ${code}: src/locales/${manifest.module}/, tests/golden/${manifest.module}/, scripts/seed-backlog/taskmap.d/${manifest.module}.yaml, contracts/${code}/`);
}

function check() {
    const diffs = [];
    const locales = LOCALES.generatedLocales(REPO);
    const expected = new Set();
    for (const committed of locales) {
        // The manifest is re-derived from upstream's exports, not trusted: a dropped configuration fails here.
        requireBuild();
        const m = lib.manifestFor(committed.code, Object.keys(require(path.join(BUILD, committed.upstream))));
        for (const [rel, text] of render(m)) {
            expected.add(rel);
            const abs = path.join(REPO, rel);
            if (!fs.existsSync(abs) || fs.readFileSync(abs, "utf8") !== text) diffs.push(rel);
        }
    }
    // A fragment or coverage input without its locale (or one the generator wouldn't write) is stale too.
    const modules = new Set(locales.map((l) => l.module));
    for (const [dir, ext] of [["scripts/seed-backlog/taskmap.d", ".yaml"], ["harness/golden/coverage", ".json"]]) {
        const abs = path.join(REPO, dir);
        for (const f of fs.existsSync(abs) ? fs.readdirSync(abs) : []) {
            const rel = `${dir}/${f}`;
            if (!f.endsWith(ext) || !modules.has(f.slice(0, -ext.length)) || !expected.has(rel)) diffs.push(rel);
        }
    }
    if (diffs.length > 0) {
        console.error(`generated locale files differ from a fresh generation: ${diffs.join(", ")}`);
        process.exit(1);
    }
    console.log(`generated locales match a fresh generation (${locales.map((l) => l.code).join(", ") || "none"})`);
}

/**
 * The scheduled decision (lib.nextLanguage), from files the workflow fetched with a read-only token:
 * --policy (factory policies/onboarding.yaml, may be missing), --outcomes (outcomes.json, may be
 * missing), --issues (open factory:task issues), --prs (open PRs). Prints one JSON line.
 */
function next() {
    const opt = (name) => {
        const i = process.argv.indexOf(name);
        return i > 0 ? process.argv[i + 1] : null;
    };
    const readOr = (file, parse, fallback) => (file && fs.existsSync(file) && fs.statSync(file).size > 0 ? parse(fs.readFileSync(file, "utf8")) : fallback);
    const policy = readOr(opt("--policy"), (t) => YAML.parse(t), null);
    const outcomes = readOr(opt("--outcomes"), JSON.parse, null);
    const issues = readOr(opt("--issues"), JSON.parse, [])
        .map((i) => ({ id: (/<!-- factory-task: ([a-z0-9/-]+) -->/.exec(i.body || "") || [])[1], labels: (i.labels || []).map((l) => l.name || l) }))
        .filter((i) => i.id);
    const openPRs = readOr(opt("--prs"), JSON.parse, [])
        .map((p) => (/^factory\/onboard\/([a-z]{2}(?:-[a-z]{4})?)$/.exec(p.head?.ref || p.headRefName || "") || [])[1])
        .filter(Boolean);
    const decision = lib.nextLanguage({
        policy,
        onboarded: LOCALES.generatedLocales(REPO).map((l) => l.code),
        candidates: candidates(),
        outcomes,
        issues,
        openPRs,
    });
    console.log(JSON.stringify(decision));
}

function main() {
    const [cmd, arg] = process.argv.slice(2);
    if (cmd === "add" && arg) return add(arg);
    if (cmd === "check") return check();
    if (cmd === "candidates") return console.log(candidates().join("\n"));
    if (cmd === "next") return next();
    console.error("usage: onboard.js add <code> | check | candidates | next --policy F --outcomes F --issues F --prs F");
    process.exit(2);
}

try {
    main();
} catch (e) {
    console.error(e.message);
    process.exit(1);
}
