#!/usr/bin/env node
"use strict";
// Language onboarding generator. Deterministic; no AI. Replaces the hand-written per-language
// setup (the scaffold, golden and contracts PRs of the pilot and wave 1).
//
//   node onboard/onboard.js add <code>   onboard one upstream locale (fi, it, zh-hans, ...)
//   node onboard/onboard.js check        re-render every generated locale's files; fail on any difference
//                                        (or a contract scope file without its directory)
//   node onboard/onboard.js check --write   write them instead (after a generator change), then check
//   node onboard/onboard.js candidates [--policy P]   upstream locales not onboarded yet, one per line
//                                        (with the onboarding policy: its external locales left out)
//   node onboard/onboard.js drill [code...]   onboard each (default: every candidate) in a throwaway copy;
//                                        fail if a contract scope file's directory isn't generated
//   node onboard/onboard.js next ...     the scheduled pipeline's decision (see next() and lib.nextLanguage)
//
// `add` writes, all from the pinned chrono-node in upstream/ (built: npm run build:upstream):
//   src/locales/<module>/locale.json            the manifest (lib/locales.js); the other tools read it
//   tests/golden/<module>/*.json, index.json,   the golden generator, now including the locale's tests
//     configurations.json
//   src/locales/<module>/mod.rs, configuration.rs   the configurations' slots, from configurations.json
//   src/locales/<module>/{parsers,refiners,...}/.gitkeep   the module skeleton: every directory a task's
//                                                   scope file goes in, so no agent needs mkdir
//   scripts/seed-backlog/taskmap.d/<module>.yaml    one task per locale step, one support task per
//                                                   shared file (constants.ts, a locale base class)
//   contracts/<code>/*.yaml                     the seed script, from the task map fragment
// What needs judgement is not generated: porting constants and every step is agent work, gated by
// golden cases (steps) and by unit cases recorded from chrono-node here (constants).
// Fails closed: a locale whose configurations use a step that's neither one of its own files nor
// already in the task map is refused, with the reason.
// Everything recorded here (unit cases from chrono-node) is recorded in UTC, as CI and the golden generator run.
process.env.TZ = "UTC";
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

/** Hand-reviewed seeds and unreachable steps (hints.yaml); verified against chrono-node on every render. */
const hints = () => YAML.parse(read("harness/onboard/hints.yaml")) || {};

/**
 * Coverage requests for the locale's steps that no upstream test exercises: the first
 * COVERAGE_PER_STEP requests of a fixed phrase stream (the comparison's golden-text phrases, seeded
 * by the module name) whose chrono-node trace needs the step, then hints.yaml seeds whose trace needs
 * it. A step none reaches is refused unless hints.yaml declares it unreachable and the evidence still
 * holds (unreachableProblems). Returns {coverage (null if every step is covered), unreachable: [step]}.
 */
function coverageInput(manifest, configs, fragment) {
    const S = require("../lib/serialize");
    const { trace } = require("../lib/trace");
    const phrases = require("../compare/phrases");
    const H = hints();
    const covered = new Set(upstreamCases(manifest.module).flatMap((c) => [...c.requires.parsers, ...c.requires.refiners]));
    const missing = fragment.tasks.filter((t) => t.step && !covered.has(t.step)).map((t) => t.step).sort();
    for (const step of Object.keys(H.unreachable || {})) {
        if (fragment.tasks.some((t) => t.step === step) && covered.has(step)) throw new Error(`hints.yaml: ${step} is declared unreachable, but an upstream test exercises it: remove it`);
    }
    if (missing.length === 0) return { coverage: null, unreachable: [] };
    S.registerUpstreamAliases((p) => require(path.join(BUILD, p)));
    const chronoModule = require(path.join(BUILD, "chrono"));
    const L = require(path.join(BUILD, manifest.upstream));
    const g = { module: manifest.module, configs: Object.keys(configs).sort(), texts: goldenTexts(manifest.module) };
    const r = phrases.prng(phrases.fnv1a(`coverage:${manifest.module}`));
    const found = new Map(missing.map((s) => [s, []]));
    const record = (req, t) => {
        for (const step of [...t.parsers, ...t.refiners]) {
            const list = found.get(step);
            if (list && list.length < COVERAGE_PER_STEP && !list.some((x) => x.text === req.text && x.config === req.config)) list.push({ step, ...req });
        }
    };
    for (let i = 0; i < COVERAGE_SEARCH && [...found.values()].some((l) => l.length < COVERAGE_PER_STEP); i++) {
        const { id, ...req } = phrases.goldenTextRequest(r, g, i);
        const ref = req.reference.kind === "date" ? new Date(req.reference.instant) : { instant: new Date(req.reference.instant), timezone: req.reference.timezone_input ?? undefined };
        record(req, trace(chronoModule, L[manifest.configs[req.config]], req.text, ref, { ...req.options }));
    }
    for (const step of missing) {
        for (const seed of (H.seeds || {})[step] || []) {
            if (found.get(step).length >= COVERAGE_PER_STEP) break;
            if (!manifest.configs[seed.config]) throw new Error(`hints.yaml: seed for ${step} names config ${seed.config}, not one of ${manifest.code}'s`);
            const req = { text: seed.text, config: seed.config, reference: { kind: "date", instant: seed.reference, timezone_input: null }, system_timezone: "UTC", options: seed.options || {} };
            const t = trace(chronoModule, L[manifest.configs[seed.config]], req.text, new Date(seed.reference), { ...req.options });
            if ([...t.parsers, ...t.refiners].includes(step)) record(req, { parsers: [], refiners: [step] });
        }
    }
    const unreachable = [];
    const empty = [];
    for (const [step, list] of found) {
        const declared = (H.unreachable || {})[step];
        if (list.length > 0 && declared) throw new Error(`hints.yaml: ${step} is declared unreachable, but "${list[0].text}" (${list[0].config}) exercises it: remove it`);
        if (list.length > 0) continue;
        if (!declared) {
            empty.push(step);
            continue;
        }
        const problems = unreachableProblems(manifest, step, declared);
        if (problems.length > 0) throw new Error(`hints.yaml: ${step}'s unreachable evidence no longer holds:\n  ${problems.join("\n  ")}`);
        unreachable.push(step);
    }
    if (empty.length > 0) throw new Error(`cannot onboard ${manifest.code}: no upstream test and no generated phrase exercises ${empty.join(", ")} (a hand decision)`);
    const requests = [...found.values()].flat();
    return { coverage: requests.length ? { generator: lib.GENERATOR, module: manifest.module, requests } : null, unreachable };
}

/** Every probe text of an unreachable entry: each sequence of 1..max_tokens tokens (space-joined), in each frame. */
function probeTexts(probe) {
    const tokens = probe.tokens || [];
    const max = Math.min(probe.max_tokens ?? 1, 4);
    let seqs = tokens.map((t) => [t]);
    const all = [...seqs];
    for (let n = 2; n <= max; n++) {
        seqs = seqs.flatMap((s) => tokens.map((t) => [...s, t]));
        all.push(...seqs);
    }
    return (probe.frames || ["{}"]).flatMap((f) => all.map((s) => f.replace("{}", s.join(" "))));
}

/**
 * Re-checks a hints.yaml unreachable entry against the pinned chrono-node: no probe text traces the
 * step in any listed config and option set. Returns the problems (none = the evidence holds).
 */
function unreachableProblems(manifest, step, entry) {
    const S = require("../lib/serialize");
    const { trace } = require("../lib/trace");
    S.registerUpstreamAliases((p) => require(path.join(BUILD, p)));
    const chronoModule = require(path.join(BUILD, "chrono"));
    const L = require(path.join(BUILD, manifest.upstream));
    const problems = [];
    const p = entry.probe || {};
    if (typeof entry.reason !== "string" || !entry.reason.trim()) problems.push("no reason");
    const texts = probeTexts(p);
    if (!Array.isArray(p.configs) || p.configs.length === 0 || texts.length === 0) return [...problems, "no probe corpus"];
    for (const cfg of p.configs) {
        if (!manifest.configs[cfg]) {
            problems.push(`probe config ${cfg} is not one of ${manifest.code}'s`);
            continue;
        }
        const chrono = L[manifest.configs[cfg]];
        for (const options of p.options || [{}]) {
            for (const text of texts) {
                const t = trace(chronoModule, chrono, text, new Date("2024-03-06T12:00:00.000Z"), { ...options });
                if ([...t.parsers, ...t.refiners].includes(step)) problems.push(`${cfg} ${JSON.stringify(options)} reaches it: ${JSON.stringify(text)}`);
                if (problems.length >= 5) return problems;
            }
        }
    }
    return problems;
}

/**
 * The unit acceptance of a step hints.yaml declares unreachable: each case recorded by running the
 * upstream step alone on its input (`parsers`: the config's own parser results for the text; else
 * the listed results), in a context for the case's text, reference and options.
 */
function unreachableUnit(manifest, task, entry) {
    const S = require("../lib/serialize");
    S.registerUpstreamAliases((p) => require(path.join(BUILD, p)));
    const { Chrono, ParsingContext } = require(path.join(BUILD, "chrono"));
    const R = require(path.join(BUILD, "results"));
    const L = require(path.join(BUILD, manifest.upstream));
    const cases = (entry.cases || []).map((c) => {
        if (!manifest.configs[c.config]) throw new Error(`hints.yaml: ${task.step} case ${c.test} names config ${c.config}, not one of ${manifest.code}'s`);
        const chrono = L[manifest.configs[c.config]];
        const options = c.options || {};
        const ctx = new ParsingContext(c.text, new Date(c.reference), options);
        const input =
            c.input === "parsers"
                ? chrono.parsers.flatMap((p) => Chrono.executeParser(ctx, p)).sort((a, b) => a.index - b.index)
                : c.input.map((x) => new R.ParsingResult(ctx.reference, x.index, x.text, new R.ParsingComponents(ctx.reference, x.known)));
        const step = chrono.refiners.find((x) => S.stepName(x) === task.step);
        if (!step) throw new Error(`hints.yaml: ${task.step} is not in ${c.config}'s refiners`);
        const before = S.serializeResults(input);
        const out = step.refine(ctx, input);
        return { test: c.test, kind: "refine", config: c.config, text: c.text, reference: c.reference, ...(Object.keys(options).length ? { options } : {}), input: before, expect: { results: S.serializeResults(out) } };
    });
    return {
        requirement:
            `Port upstream \`${task.source}\` into this one file, as PORTING.md says. No input reaches this step in the pinned chrono-node (\`harness/onboard/hints.yaml\`: ${entry.reason.replace(/\s+/g, " ").trim()}), so it has no golden case. ` +
            "Add one in-file `#[cfg(test)]` test per case, named the case's `test` (CI checks the names); the cases were recorded from the pinned chrono-node: `refine`: in a context for `text` with `reference` (and `options`), run this step alone on `input` (results serialized as in the golden files: `index` in UTF-16 code units, `known` components given, the rest implied) and the output must equal `expect.results`.",
        cases,
    };
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
    const { coverage, unreachable } = coverageInput(manifest, configs, fragment);
    for (const step of unreachable) {
        const t = fragment.tasks.find((x) => x.step === step);
        const entry = hints().unreachable[step];
        t.unreachable = entry.reason.replace(/\s+/g, " ").trim();
        t.unit = unreachableUnit(manifest, t, entry);
    }
    return new Map([
        ...(coverage ? [[`harness/golden/coverage/${manifest.module}.json`, renderCoverage(coverage)]] : []),
        [`src/locales/${manifest.module}/${LOCALES.MANIFEST}`, lib.renderManifest(manifest)],
        [`src/locales/${manifest.module}/mod.rs`, lib.renderModRs(manifest)],
        [`src/locales/${manifest.module}/configuration.rs`, lib.renderConfigurationRs(manifest, configs)],
        [`scripts/seed-backlog/taskmap.d/${manifest.module}.yaml`, lib.renderFragment(fragment)],
        ...lib.moduleSkeleton(manifest, fragment),
    ]);
}

/**
 * Contract scope files of one locale whose parent directory doesn't exist: each would need an agent
 * to mkdir, which its sandbox can't (and shouldn't) do. Empty when the skeleton is complete.
 */
function missingScopeParents(code) {
    const dir = path.join(REPO, "contracts", code);
    const scopes = (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort() : []).flatMap(
        (f) => YAML.parse(fs.readFileSync(path.join(dir, f), "utf8")).scope || [],
    );
    return lib.missingScopeParents(scopes, (d) => fs.existsSync(path.join(REPO, d)) && fs.statSync(path.join(REPO, d)).isDirectory());
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
        const missing = missingScopeParents(code);
        if (missing.length > 0) throw new Error(`contract scope files without a directory (an agent can't mkdir): ${missing.join(", ")}`);
    } catch (e) {
        console.error(`onboarding ${code} failed. Undo: git checkout -- tests/golden contracts && git clean -fd src/locales/${manifest.module} tests/golden scripts/seed-backlog/taskmap.d contracts`);
        throw e;
    }
    console.log(`onboarded ${code}: src/locales/${manifest.module}/, tests/golden/${manifest.module}/, scripts/seed-backlog/taskmap.d/${manifest.module}.yaml, contracts/${code}/`);
}

/** `check --write`: re-render every generated locale in place (after a generator change), then check. */
function check(write = false) {
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
            if (write) {
                fs.mkdirSync(path.dirname(abs), { recursive: true });
                fs.writeFileSync(abs, text);
            } else if (!fs.existsSync(abs) || fs.readFileSync(abs, "utf8") !== text) diffs.push(rel);
        }
        if (write) continue;
        diffs.push(...new Set(missingScopeParents(committed.code).map((s) => `${path.posix.dirname(s)}/ (a contract scope directory)`)));
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
    if (write) return check(false);
    if (diffs.length > 0) {
        console.error(`generated locale files differ from a fresh generation: ${diffs.join(", ")}`);
        process.exit(1);
    }
    console.log(`generated locales match a fresh generation (${locales.map((l) => l.code).join(", ") || "none"})`);
}

const DRILL_SKIP = new Set([".git", "target", "node_modules", ".build"]);

/**
 * The skeleton drill: onboard each language (default: every candidate) in a throwaway copy of the
 * repo, then assert every contract scope file's parent directory exists and the copy passes
 * `check`. Writes nothing here. Needs the upstream build and scripts/seed-backlog's npm ci.
 */
function drill(codes) {
    requireBuild();
    const list = codes.length ? codes : candidates();
    const failed = [];
    for (const code of list) {
        const tmp = fs.mkdtempSync(path.join(require("os").tmpdir(), `onboard-drill-${code}-`));
        try {
            fs.cpSync(REPO, tmp, { recursive: true, filter: (src) => !DRILL_SKIP.has(path.basename(src)) });
            for (const rel of ["harness/node_modules", "harness/.build", "scripts/seed-backlog/node_modules"]) {
                if (fs.existsSync(path.join(REPO, rel))) fs.symlinkSync(path.join(REPO, rel), path.join(tmp, rel));
            }
            const onboard = path.join(tmp, "harness/onboard/onboard.js");
            const res = spawnSync(process.execPath, [onboard, "add", code], { cwd: path.join(tmp, "harness"), encoding: "utf8", maxBuffer: 1 << 28 });
            if (res.status !== 0) {
                // The generator failing closed (a hand decision) writes no contracts: nothing for an agent to trip on.
                const refusal = /^cannot onboard [^\n]*/m.exec(res.stderr);
                if (refusal) {
                    console.log(`drill ${code}: skipped, onboarding refused (${refusal[0]})`);
                    continue;
                }
                throw new Error(`add failed:\n${res.stdout}${res.stderr}`);
            }
            const scopes = fs.readdirSync(path.join(tmp, "contracts", code)).filter((f) => f.endsWith(".yaml"))
                .flatMap((f) => YAML.parse(fs.readFileSync(path.join(tmp, "contracts", code, f), "utf8")).scope || []);
            const files = scopes.filter((s) => s.startsWith("src/"));
            if (files.length === 0) throw new Error("no contract has a scope file");
            const missing = lib.missingScopeParents(files, (d) => fs.existsSync(path.join(tmp, d, ".gitkeep")) || d === `src/locales/${code.replace("-", "_")}`);
            if (missing.length) throw new Error(`scope files without a committed directory: ${missing.join(", ")}`);
            const modDir = `src/locales/${code.replace("-", "_")}`;
            const generated = fs.readdirSync(path.join(tmp, modDir), { recursive: true }).map((f) => `${modDir}/${f.split(path.sep).join("/")}`);
            const wf = YAML.parse(read(".github/workflows/onboard.yml"));
            const wfProblems = lib.workflowProblems(wf, generated);
            if (wfProblems.length) throw new Error(`onboard.yml: ${wfProblems.join("; ")}`);
            const chk = spawnSync(process.execPath, [onboard, "check"], { cwd: path.join(tmp, "harness"), encoding: "utf8" });
            if (chk.status !== 0) throw new Error(`check failed after add:\n${chk.stdout}${chk.stderr}`);
            console.log(`drill ${code}: ok (${files.length} scope files, every parent directory generated)`);
        } catch (e) {
            failed.push(code);
            console.error(`drill ${code}: FAILED: ${e.message}`);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    }
    if (failed.length) {
        console.error(`skeleton drill failed for ${failed.join(", ")}`);
        process.exit(1);
    }
}

/**
 * The onboarding decision (lib.nextLanguage), from files the workflow fetched with a read-only token:
 * --policy (factory policies/onboarding.yaml; missing = no onboarding), --issues (factory:task issues,
 * every state), --prs (open PRs), --onboard-merges (merged onboarding PRs: [{head: {ref}, merged_at}]),
 * --runs (completed agent runs, Actions API: [{run_id, workflow, title, conclusion, created_at}]),
 * --merged (merged agent PRs, GraphQL nodes: [{number, title, createdAt, comments, reviews, commits}])
 * and --audit (the controller's audit events, jsonl: run_spend, spend_snapshot and infra-incident
 * records). The task contracts come from this checkout. Every input is required: one missing or
 * unreadable makes the decision wait. Optional: --onboard-prs (each open onboarding PR's
 * mergeable_state, commits and files; lib.pureGeneratorPr): without it a conflicting onboarding PR
 * just waits, never regenerated. Prints one JSON line.
 */
function next() {
    const opt = (name) => {
        const i = process.argv.indexOf(name);
        return i > 0 ? process.argv[i + 1] : null;
    };
    const readOr = (file, parse, fallback) => (file && fs.existsSync(file) && fs.statSync(file).size > 0 ? parse(fs.readFileSync(file, "utf8")) : fallback);
    const policy = readOr(opt("--policy"), (t) => YAML.parse(t), null);
    // Missing, empty or not a list = unreadable (null): the decision waits, never reads it as "none".
    const list = (name) => readOr(opt(name), (t) => (Array.isArray(JSON.parse(t)) ? JSON.parse(t) : null), null);
    const issues = list("--issues")
        ?.map((i) => ({ id: (/<!-- factory-task: ([a-z0-9/-]+) -->/.exec(i.body || "") || [])[1], state: i.state, labels: (i.labels || []).map((l) => l.name || l) }))
        .filter((i) => i.id) ?? null;
    const openPRs = list("--prs")
        ?.map((p) => (/^factory\/onboard\/([a-z]{2}(?:-[a-z]{4})?)$/.exec(p.head?.ref || p.headRefName || "") || [])[1])
        .filter(Boolean) ?? null;
    const onboardMerges = list("--onboard-merges")
        ?.map((p) => ({ code: (/^factory\/onboard\/([a-z]{2}(?:-[a-z]{4})?)$/.exec(p.head?.ref || "") || [])[1], merged_at: p.merged_at }))
        .filter((m) => m.code && m.merged_at) ?? null;
    const onboardPRs = list("--onboard-prs");
    const ledgerRuns = list("--runs");
    const merged = list("--merged")
        ?.map((p) => ({ task: (/^\[factory\] ([a-z0-9-]+\/[a-z0-9_-]+):/.exec(p.title || "") || [])[1], number: p.number, created_at: p.createdAt, zero_touch: lib.zeroTouch(p) }))
        .filter((m) => m.task) ?? null;
    const ledger = ledgerRuns && merged ? { runs: ledgerRuns, merged } : null;
    const events = readOr(opt("--audit"), (t) => t.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)), null);
    const costs = events ? lib.runCosts(events) : null;
    const incidents = (events || [])
        .filter((e) => e && e.type === "human_action" && e.payload && e.payload.action === "infra_incident")
        .map((e) => ({ task: e.payload.task, labeled_at: e.payload.labeled_at }));
    const decision = lib.nextLanguage({
        policy,
        onboarded: LOCALES.generatedLocales(REPO).map((l) => l.code),
        candidates: candidates(),
        issues,
        openPRs,
        onboardPRs,
        contracts: generatedContractIds(),
        onboardMerges,
        ledger,
        costs,
        incidents,
        now: process.env.ONBOARD_NOW || new Date().toISOString(),
    });
    console.log(JSON.stringify(decision));
}

/** Generated locales' task contract ids on this checkout (fix contracts excluded: the intake owns them). */
function generatedContractIds() {
    const ids = [];
    for (const l of LOCALES.generatedLocales(REPO)) {
        const dir = path.join(REPO, "contracts", l.code);
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir).sort()) if (f.endsWith(".yaml") && !f.startsWith("fix-")) ids.push(`${l.code}/${f.slice(0, -5)}`);
    }
    return ids;
}

/**
 * `hints-check [--hints F]`: every hints.yaml entry still holds against the pinned chrono-node. A
 * seed traces its step (at least one per step); an unreachable step's evidence holds
 * (unreachableProblems). Prints one JSON line {ok, checked, problems}; exits 1 on a problem. (A
 * generated phrase that reaches a declared-unreachable step fails `check` for an onboarded locale.)
 */
function hintsCheck() {
    requireBuild();
    const i = process.argv.indexOf("--hints");
    const H = i > 0 ? YAML.parse(fs.readFileSync(process.argv[i + 1], "utf8")) || {} : hints();
    const S = require("../lib/serialize");
    const { trace } = require("../lib/trace");
    S.registerUpstreamAliases((p) => require(path.join(BUILD, p)));
    const chronoModule = require(path.join(BUILD, "chrono"));
    const manifestOf = (config) => {
        const code = config.split(".")[0].replace("_", "-");
        if (!upstreamCodes().includes(code)) throw new Error(`hints.yaml: ${config} names no upstream locale`);
        return lib.manifestFor(code, Object.keys(require(path.join(BUILD, `locales/${code.replace("-", "/")}`))));
    };
    const problems = [];
    let checked = 0;
    for (const [step, seeds] of Object.entries(H.seeds || {})) {
        checked++;
        const hit = seeds.some((seed) => {
            const m = manifestOf(seed.config);
            const L = require(path.join(BUILD, m.upstream));
            const t = trace(chronoModule, L[m.configs[seed.config]], seed.text, new Date(seed.reference), { ...(seed.options || {}) });
            return [...t.parsers, ...t.refiners].includes(step);
        });
        if (!hit) problems.push(`seeds: no seed for ${step} reaches it`);
    }
    for (const [step, entry] of Object.entries(H.unreachable || {})) {
        checked++;
        const configs = (entry.probe && entry.probe.configs) || [];
        if (configs.length === 0) {
            problems.push(`unreachable ${step}: no probe configs`);
            continue;
        }
        for (const p of unreachableProblems(manifestOf(configs[0]), step, entry)) problems.push(`unreachable ${step}: ${p}`);
    }
    console.log(JSON.stringify({ ok: problems.length === 0, checked, problems }));
    if (problems.length > 0) process.exitCode = 1;
}

function main() {
    const [cmd, arg] = process.argv.slice(2);
    if (cmd === "add" && arg) return add(arg);
    if (cmd === "check") return check(arg === "--write");
    if (cmd === "candidates") {
        // --policy: leave out its external locales (a dispatch must not onboard vi); unreadable: an error.
        const i = process.argv.indexOf("--policy");
        const skip = i > 0 ? new Set(require("../lib/external").readExternal(process.argv[i + 1])) : new Set();
        return console.log(candidates().filter((c) => !skip.has(c)).join("\n"));
    }
    if (cmd === "next") return next();
    if (cmd === "drill") return drill(process.argv.slice(3));
    if (cmd === "hints-check") return hintsCheck();
    console.error("usage: onboard.js add <code> | check [--write] | candidates | drill [code...] | next --policy F --issues F --prs F --onboard-merges F --runs F --merged F --audit F [--onboard-prs F] | hints-check [--hints F]");
    process.exit(2);
}

try {
    main();
} catch (e) {
    console.error(e.message);
    process.exit(1);
}
