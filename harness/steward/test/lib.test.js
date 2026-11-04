"use strict";
const test = require("node:test");
const assert = require("node:assert");
const lib = require("../lib");
const { lockPackages, checkDecision } = require("../steward");

const POLICY = {
    hard_checks: { licence_allowlist: ["MIT", "Apache-2.0", "MIT OR Apache-2.0", "Unicode-3.0"], typosquat_check: true, network_in_build_script: false, denylist: ["chrono-english", "dateparser"] },
    soft_checks: { min_crate_age_days: 90, min_downloads: 100000, max_months_since_release: 12, max_new_transitive: 5, native_code: false },
    preapproved: { runtime: ["regex"], wasm: [], dev: ["criterion"] },
    exceptions: [{ crate: "criterion", version: "0.5", kind: "dev", waives: ["max_new_transitive"] }],
};
const NOW = new Date("2026-11-04T00:00:00Z");
const facts = (over = {}) => ({
    request: { crate: "smallvec", version: "1", kind: "runtime" },
    resolved: { name: "smallvec", version: "1.13.2", licence: "MIT OR Apache-2.0", yanked: false },
    crate: { created_at: "2015-01-01T00:00:00Z", downloads: 9e8, newest_release_at: "2026-06-01T00:00:00Z" },
    new_packages: [{ name: "smallvec", version: "1.13.2", licence: "MIT OR Apache-2.0", native: false, build_script_network: false }],
    changed_locked: [],
    deny: { ok: true, failures: [] },
    popular: ["serde", "serde_json", "regex", "smallvec", "syn"],
    audited: false,
    already: false,
    now: NOW,
    ...over,
});
const body = (crate, version, kind, reason = "needed") => `### Crate\n\n${crate}\n\n### Version\n\n${version}\n\n### Kind\n\n${kind}\n\n### Reason\n\n${reason}\n\n### Task\n\nen/weekday-parser\n`;

test("parseRequest: strict fields", () => {
    assert.deepStrictEqual(lib.parseRequest(body("smallvec", "1.2", "runtime")), { crate: "smallvec", version: "1.2", kind: "runtime", task: "en/weekday-parser" });
    assert.strictEqual(lib.parseRequest(body("small vec", "1", "runtime")).error, lib.ERRORS.crate);
    assert.strictEqual(lib.parseRequest(body("smallvec", ">=1, <2", "runtime")).error, lib.ERRORS.version);
    assert.strictEqual(lib.parseRequest(body("smallvec", "1", "build")).error, lib.ERRORS.kind);
    assert.strictEqual(lib.parseRequest(body("smallvec", "1", "dev", "x".repeat(2001))).error, lib.ERRORS.reason);
});

test("nearMiss: typosquats of popular crates, not the crates themselves", () => {
    assert.strictEqual(lib.nearMiss("serde_jsn", ["serde_json"]), "serde_json");
    assert.strictEqual(lib.nearMiss("serdejson", ["serde_json"]), "serde_json");
    assert.strictEqual(lib.nearMiss("rgex", ["regex"]), "regex");
    assert.strictEqual(lib.nearMiss("serde-json", ["serde_json"]), null); // the same crate on crates.io
    assert.strictEqual(lib.nearMiss("smallvec", ["serde", "regex"]), null);
    assert.strictEqual(lib.nearMiss("syn", ["syn", "sync"]), null);
});

test("licenceAllowed: SPDX OR/AND/WITH/parentheses", () => {
    const A = POLICY.hard_checks.licence_allowlist;
    assert.ok(lib.licenceAllowed("Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT", A));
    assert.ok(lib.licenceAllowed("(MIT OR Apache-2.0) AND Unicode-3.0", A));
    assert.ok(lib.licenceAllowed("MIT/Apache-2.0", A));
    for (const e of ["GPL-3.0", "MIT AND GPL-3.0", "Apache-2.0 WITH LLVM-exception", "MIT OR", "(MIT", "", null]) assert.ok(!lib.licenceAllowed(e, A), String(e));
});

test("audited: full audits of that exact version and criteria only", () => {
    const toml = '[[audits.smallvec]]\nwho = "x"\ncriteria = "safe-to-deploy"\nversion = "1.13.2"\n\n[[audits.foo]]\ncriteria = ["safe-to-run"]\nversion = "0.1.0"\n\n[[audits.bar]]\ncriteria = "safe-to-deploy"\ndelta = "1.0.0 -> 1.1.0"\n';
    assert.ok(lib.audited(toml, "smallvec", "1.13.2", "runtime"));
    assert.ok(!lib.audited(toml, "smallvec", "1.13.1", "runtime"));
    assert.ok(lib.audited(toml, "foo", "0.1.0", "dev"));
    assert.ok(!lib.audited(toml, "foo", "0.1.0", "runtime"));
    assert.ok(!lib.audited(toml, "bar", "1.1.0", "runtime"));
});

test("decide: pass, hard failures, borderline and waivers", () => {
    assert.deepStrictEqual(lib.decide(facts(), POLICY), { verdict: "pass", hard: [], soft: [], waived: [] });
    assert.deepStrictEqual(lib.decide(facts({ request: { crate: "date-parser", version: "1", kind: "runtime" } }), { ...POLICY, hard_checks: { ...POLICY.hard_checks, denylist: ["date_parser"] } }).hard, ["denylist"]);
    assert.ok(lib.decide(facts({ new_packages: [{ name: "x", version: "1.0.0", licence: "GPL-3.0" }] }), POLICY).hard.includes("licence:x"));
    assert.ok(lib.decide(facts({ deny: { ok: false, failures: ["vulnerability"] } }), POLICY).hard.includes("cargo_deny:vulnerability"));
    assert.ok(lib.decide(facts({ deny: { ok: false, failures: [] } }), POLICY).hard.includes("cargo_deny:unknown"));
    assert.ok(lib.decide(facts({ new_packages: [{ name: "y", version: "1.0.0", licence: "MIT", build_script_network: true }] }), POLICY).hard.includes("build_script_network:y"));
    assert.ok(lib.decide(facts({ resolved: { ...facts().resolved, yanked: true } }), POLICY).hard.includes("yanked"));
    const young = facts({ crate: { created_at: "2026-10-01T00:00:00Z", downloads: 10, newest_release_at: "2026-10-01T00:00:00Z" } });
    assert.deepStrictEqual(lib.decide(young, POLICY), { verdict: "borderline", hard: [], soft: ["min_crate_age_days", "min_downloads"], waived: [] });
    assert.deepStrictEqual(lib.decide({ ...young, audited: true }, POLICY).verdict, "pass");
    const many = Array.from({ length: 7 }, (_, i) => ({ name: `d${i}`, version: "1.0.0", licence: "MIT" }));
    assert.deepStrictEqual(lib.decide(facts({ new_packages: many }), POLICY).soft, ["max_new_transitive"]);
    const crit = facts({ request: { crate: "criterion", version: "0.5", kind: "dev" }, resolved: { name: "criterion", version: "0.5.1", licence: "MIT", yanked: false }, new_packages: many });
    assert.deepStrictEqual(lib.decide(crit, { ...POLICY, preapproved: { runtime: [], wasm: [], dev: [] } }).waived, ["max_new_transitive:exception"]);
    assert.strictEqual(lib.decide(facts({ request: { crate: "regex", version: "1", kind: "runtime" }, new_packages: many }), POLICY).verdict, "pass");
    assert.deepStrictEqual(lib.decide(facts({ changed_locked: ["libc"] }), POLICY).soft, ["changes_locked_versions"]);
    assert.strictEqual(lib.decide(facts({ already: true }), POLICY).verdict, "already");
});

test("buildScriptNetwork and isNative", () => {
    assert.ok(!lib.buildScriptNetwork('// see https://example.com\nfn main() { let rev = Command::new("git").args(["rev-parse", "HEAD"]); }', []));
    assert.ok(lib.buildScriptNetwork("fn main() { std::net::TcpStream::connect(x); }", []));
    assert.ok(lib.buildScriptNetwork('fn main() { Command::new("curl").arg(u); }', []));
    assert.ok(lib.buildScriptNetwork('fn main() { Command::new("git").args(["clone", u]); }', []));
    assert.ok(lib.buildScriptNetwork("fn main() {}", ["reqwest"]));
    assert.ok(lib.isNative("z", []) && lib.isNative(null, ["cc"]) && !lib.isNative(null, ["version_check"]));
});

test("lockPackages and checkDecision", () => {
    assert.deepStrictEqual(lockPackages('version = 4\n\n[[package]]\nname = "a"\nversion = "1.0.0"\n\n[[package]]\nname = "b"\nversion = "2.0.0"\nsource = "x"\n'), ["a@1.0.0", "b@2.0.0"]);
    const ok = { verdict: "pass", request: { crate: "smallvec", version: "1", kind: "runtime" }, resolved: { name: "smallvec", version: "1.13.2" }, hard: [], soft: [], waived: ["x:preapproved"] };
    assert.strictEqual(checkDecision(ok).verdict, "pass");
    assert.throws(() => checkDecision({ ...ok, hard: ["<script>"] }));
    assert.throws(() => checkDecision({ ...ok, verdict: "merge" }));
    assert.throws(() => checkDecision({ verdict: "invalid", error: "@everyone" }));
    assert.throws(() => checkDecision({ ...ok, resolved: { name: "smallvec", version: "1; rm -rf /" } }));
});

test("decide: a trusted audit covers the requested crate's native code, not a new native transitive crate", () => {
    const pkgs = [
        { name: "smallvec", version: "1.13.2", licence: "MIT", native: true },
        { name: "foo-sys", version: "0.1.0", licence: "MIT", native: true },
    ];
    const d = lib.decide(facts({ new_packages: pkgs, audited: true }), POLICY);
    assert.deepStrictEqual([d.verdict, d.soft, d.waived], ["borderline", ["native_code:foo-sys"], ["native_code:audited"]]);
});

test("buildScriptNetwork: a string with // never hides code after it; comments are still ignored", () => {
    assert.ok(lib.buildScriptNetwork('fn main() { let u = "https://x.example/a"; Command::new("curl").arg(u); }', []));
    assert.ok(!lib.buildScriptNetwork('fn main() { /* Command::new("curl") /* nested */ */ let u = "a//b"; }', []));
    assert.ok(lib.buildScriptNetwork('fn main() { let u = r#"https://x"#; std::net::TcpStream::connect(u); }', []));
    assert.strictEqual(lib.stripRustComments('a // c\nb /* x */ "d//e" \'/\''), 'a \nb   "d//e" \'/\'');
});
