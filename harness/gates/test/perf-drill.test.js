// Drill D8c (drills/README.md, removed with the drills): the bench hook can only make a change look
// slower. harness/strict/perf.sh refuses a base that has the drill file, before measuring anything.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SCRIPT = path.resolve(__dirname, "../../strict/perf.sh");
const MARKER = "src/locales/en/parsers/factory_drill_gate_perf.rs";

function repoWith(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perf-drill-"));
    const git = (...a) => spawnSync("git", a, { cwd: dir, encoding: "utf8" });
    git("init", "-q");
    for (const [f, text] of Object.entries(files)) {
        fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
        fs.writeFileSync(path.join(dir, f), text);
    }
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
    return { dir, sha: git("rev-parse", "HEAD").stdout.trim() };
}

function perf(dir, sha) {
    return spawnSync("bash", [SCRIPT], {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, BASE_REV: sha, MAX_PCT: "5", KIND: "factory", EVENT: "pull_request", RUNNER_TEMP: dir, PATH: process.env.PATH },
    });
}

test("perf.sh refuses a base that has the D8c drill file (the hook would hide a regression)", () => {
    const { dir, sha } = repoWith({ "benches/golden_phrases.rs": "// bench\n", [MARKER]: "// drill\n" });
    const r = perf(dir, sha);
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /the base has the D8c perf drill file/);
    assert.doesNotMatch(r.stdout + r.stderr, /cargo bench/, "refused before measuring");
});

test("the bench hook only ever adds rounds (1 normally, 2 with the drill file)", () => {
    const bench = fs.readFileSync(path.resolve(__dirname, "../../../benches/golden_phrases.rs"), "utf8");
    const fn = bench.slice(bench.indexOf("fn drill_rounds()"), bench.indexOf("fn golden_phrases("));
    assert.match(fn, /factory_drill_gate_perf\.rs/);
    assert.deepStrictEqual([...fn.matchAll(/^\s+(\d+)$/gm)].map((m) => Number(m[1])).sort(), [1, 2]);
});
