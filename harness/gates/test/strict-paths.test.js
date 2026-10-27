// Strict gates vs absolute paths (drill D8d, 2026-10-27): steps auto-registered by build.rs are
// included with an absolute `#[path]`, so clippy reports them under the canonical absolute path. Every
// gate comparison with repo-relative paths must normalize first, or it silently counts nothing.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { evaluate } = require("../scope");

const STRICT = path.resolve(__dirname, "../../strict");
const LINTS = ["clippy::cognitive_complexity", "clippy::too_many_lines", "clippy::fn_params_excessive_bools", "clippy::struct_excessive_bools"];
const STEP = "src/locales/en/parsers/x.rs";
const BOOLS = "pub struct F { pub a: bool, pub b: bool, pub c: bool, pub d: bool }\n";

const msg = (file, code) => JSON.stringify({ reason: "compiler-message", message: { code: { code }, spans: [{ is_primary: true, file_name: file }] } });

test("code-health counting makes clippy's absolute (canonical) paths repo-relative", () => {
    const root = "/tmp/checkout/";
    const lines = [
        msg(`${root}${STEP}`, "clippy::struct_excessive_bools"), // build.rs #[path]: absolute
        msg("src/core/a.rs", "clippy::too_many_lines"), // module tree: relative
        msg("/elsewhere/src/b.rs", "clippy::too_many_lines"), // outside the checkout: unchanged
        msg(`${root}${STEP}`, "clippy::needless_return"), // not a counted lint
        JSON.stringify({ reason: "compiler-artifact" }),
    ].join("\n");
    const r = spawnSync("jq", ["-r", "--argjson", "lints", JSON.stringify(LINTS), "--arg", "root", root, "-f", path.join(STRICT, "code-health-count.jq")], { input: lines, encoding: "utf8" });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(r.stdout.trim().split("\n"), [`${STEP}\tclippy::struct_excessive_bools`, "src/core/a.rs\tclippy::too_many_lines", "/elsewhere/src/b.rs\tclippy::too_many_lines"]);
});

test("rel_paths (paths.sh) strips the checkout's canonical root and leaves everything else", () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relpaths-")));
    const input = `${dir}/${STEP}\nsrc/core/a.rs\n/other/${STEP}\n${dir}x/${STEP}\n`;
    const r = spawnSync("bash", ["-c", `source "${STRICT}/paths.sh"; rel_paths "${dir}"`], { input, encoding: "utf8" });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(r.stdout.trim().split("\n"), [STEP, "src/core/a.rs", `/other/${STEP}`, `${dir}x/${STEP}`]);
});

test("scope check: an absolute changed path is never in scope or allowed (fails closed)", () => {
    const contract = { scope: [STEP], acceptance: [], lastCommit: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678" };
    const r = evaluate({
        isAgent: true,
        body: "x\n\nFactory-Task: en/x\nContract-SHA: a1b2c3d\n",
        changed: [`/checkout/repo/${STEP}`],
        protectedGlobs: [".github/**"],
        loadContract: () => contract,
    });
    assert.strictEqual(r.ok, false);
    assert.ok(r.reasons.some((x) => x.startsWith("out of contract scope: /checkout/")), r.reasons.join("; "));
});

// code-health.sh end to end, offline: a fake `cargo` reports struct_excessive_bools under the
// file's absolute canonical path whenever the step file has the 4-bool struct (as clippy does).
function gateRun(baseText, headText) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-health-")));
    const repo = path.join(dir, "repo");
    const bin = path.join(dir, "bin");
    fs.mkdirSync(path.join(repo, path.dirname(STEP)), { recursive: true });
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "cargo"), `#!/usr/bin/env bash
f="$(pwd -P)/${STEP}"
if grep -q 'pub d: bool' "$f" 2>/dev/null; then echo '${msg("__F__", "clippy::struct_excessive_bools")}' | sed "s#__F__#$f#"; fi
echo '{"reason":"build-finished","success":true}'
`, { mode: 0o755 });
    const git = (...a) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo, encoding: "utf8" });
    git("init", "-q");
    fs.writeFileSync(path.join(repo, "Cargo.toml"), "[package]\nname = \"x\"\n");
    fs.writeFileSync(path.join(repo, "src/lib.rs"), "\n");
    fs.writeFileSync(path.join(repo, STEP), baseText);
    git("add", "-A");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD").stdout.trim();
    fs.writeFileSync(path.join(repo, STEP), headText);
    git("commit", "-qam", "head");
    return spawnSync("bash", [path.join(STRICT, "code-health.sh")], {
        cwd: repo,
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, BASE_REV: base, KIND: "factory", EVENT: "pull_request", RUNNER_TEMP: dir },
    });
}

test("D8d offline: a step file gaining a 4-bool struct fails the code-health gate", () => {
    const r = gateRun("// step\n", `// step\n${BOOLS}`);
    assert.strictEqual(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /clippy::struct_excessive_bools 0 -> 1 in src\/locales\/en\/parsers\/x\.rs/);
});

test("the gate compares the change with its base: an existing warning doesn't block an unrelated edit", () => {
    const r = gateRun(`// step\n${BOOLS}`, `// step, edited\n${BOOLS}`);
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /struct_excessive_bools: base 1, change 1/);
    assert.match(r.stdout, /code_health_not_worse: ok/);
});
