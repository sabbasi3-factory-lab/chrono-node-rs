"use strict";
// Generated locales: languages onboarded by harness/onboard/onboard.js (no hand-written scaffold).
// Each has a manifest, src/locales/<module>/locale.json:
//   { "generator": "harness/onboard/onboard.js", "code": "fi", "module": "fi",
//     "upstream": "locales/fi", "tests": "test/fi", "configs": { "fi.casual": "casual", "fi.strict": "strict" } }
// - code:     task-id prefix and label part (`fi`, `zh-hans`)
// - module:   Rust module, src/locales/<module>/ and the golden group tests/golden/<module>/
// - upstream: the locale's module under upstream/src (its index exports the named Chrono instances)
// - tests:    the upstream test directory recorded into tests/golden/<module>/
// - configs:  named configuration -> the upstream export (`casual`, `strict`) it is recorded from
// The hand-scaffolded languages (core, en, de, fr, sv, pt, es, ja) have no manifest and keep their
// fixed lists, so nothing about them changes when a language is generated.
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "../..");
const BASE_GROUPS = ["core", "en", "de", "fr", "sv", "pt", "es", "ja"];
const MANIFEST = "locale.json";

const CODE = /^[a-z]{2}(?:-[a-z]{4})?$/;
const MODULE = /^[a-z]{2}(?:_[a-z]{4})?$/;
const UPSTREAM = /^locales\/[a-z]{2}(?:\/[a-z]{4})?$/;
const TESTS = /^test\/[a-z]{2}(?:\/[a-z]{4})?$/;
const CONFIG_NAME = /^[a-z]{2}(?:\.[a-z]{4})?\.(casual|strict)$/;

/** Validates one manifest; throws on anything unexpected (fail closed). */
function checkManifest(m, where) {
    const bad = (why) => {
        throw new Error(`${where}: ${why}`);
    };
    if (!m || typeof m !== "object") bad("not an object");
    const keys = Object.keys(m).sort().join(",");
    if (keys !== "code,configs,generator,module,tests,upstream") bad(`unexpected fields ${keys}`);
    if (m.generator !== "harness/onboard/onboard.js") bad("generator");
    if (!CODE.test(m.code) || !MODULE.test(m.module) || m.module !== m.code.replace("-", "_")) bad("code/module");
    if (!UPSTREAM.test(m.upstream) || m.upstream !== `locales/${m.code.replace("-", "/")}`) bad("upstream");
    if (!TESTS.test(m.tests) || m.tests !== `test/${m.code.replace("-", "/")}`) bad("tests");
    if (BASE_GROUPS.includes(m.module)) bad(`${m.module} is a hand-scaffolded language`);
    const prefix = m.code.replace("-", ".");
    const names = Object.keys(m.configs || {});
    if (names.length === 0) bad("no configs");
    for (const n of names) {
        const mm = CONFIG_NAME.exec(n);
        if (!mm || !n.startsWith(`${prefix}.`) || m.configs[n] !== mm[1]) bad(`config ${n}`);
    }
    return m;
}

/** Every generated locale under <repo>/src/locales, sorted by module. */
function generatedLocales(repo = REPO) {
    const dir = path.join(repo, "src/locales");
    if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const name of fs.readdirSync(dir).sort()) {
        const file = path.join(dir, name, MANIFEST);
        if (!fs.existsSync(file)) continue;
        const m = checkManifest(JSON.parse(fs.readFileSync(file, "utf8")), `src/locales/${name}/${MANIFEST}`);
        if (m.module !== name) throw new Error(`src/locales/${name}/${MANIFEST}: module ${m.module} != directory`);
        out.push(m);
    }
    return out;
}

/** Golden groups: the fixed hand-scaffolded list, then the generated locales' modules. */
function goldenGroups(repo = REPO) {
    return [...BASE_GROUPS, ...generatedLocales(repo).map((l) => l.module)];
}

/** The upstream module object of a generated locale (`load` maps a src-relative path to a module). */
function upstreamModule(locale, load) {
    return load(locale.upstream);
}

module.exports = { BASE_GROUPS, MANIFEST, checkManifest, generatedLocales, goldenGroups, upstreamModule };
