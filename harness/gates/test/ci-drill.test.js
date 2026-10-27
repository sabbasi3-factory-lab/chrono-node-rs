// drills/ci-drill.sh (drills/README.md, removed with the drills): its deliberate failures only ever
// fail a step, and a PR that deletes an old drill file (D8a) gets past the D1/D1b check.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SCRIPT = path.resolve(__dirname, "../../../drills/ci-drill.sh");
const P = "src/locales/en/parsers/";

function repo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-drill-"));
    const git = (...a) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir, encoding: "utf8" });
    git("init", "-q");
    const commit = (files, remove = []) => {
        for (const [f, text] of Object.entries(files)) {
            fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
            fs.writeFileSync(path.join(dir, f), text);
        }
        for (const f of remove) fs.rmSync(path.join(dir, f));
        git("add", "-A");
        git("commit", "-qm", "c", "--allow-empty");
        return git("rev-parse", "HEAD").stdout.trim();
    };
    const run = (env, ...args) => spawnSync("bash", [SCRIPT, ...args], { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
    return { commit, run };
}

test("D8a: a PR deleting the merged D1b drill file passes the D1/D1b check", () => {
    const r = repo();
    const base = r.commit({ [`${P}factory_drill_repair_unaided.rs`]: "// drill\n", "a.txt": "a\n" });
    const head = r.commit({}, [`${P}factory_drill_repair_unaided.rs`]);
    const out = r.run({ BASE_SHA: base, HEAD_SHA: head });
    assert.strictEqual(out.status, 0, out.stdout + out.stderr);
    assert.match(out.stdout, /deleted by this PR/);
});

test("D1b: a changed (not deleted) D1b file without the repair line still fails", () => {
    const r = repo();
    const base = r.commit({ "a.txt": "a\n" });
    const head = r.commit({ [`${P}factory_drill_repair_unaided.rs`]: "// drill\n" });
    assert.strictEqual(r.run({ BASE_SHA: base, HEAD_SHA: head }).status, 1);
});

test("D5: full-regression mode fails a PR changing the D5 file, and is a no-op outside pull requests", () => {
    const r = repo();
    const base = r.commit({ "a.txt": "a\n" });
    const head = r.commit({ [`${P}factory_drill_full_regression.rs`]: "// drill\n" });
    assert.strictEqual(r.run({ BASE_SHA: base, HEAD_SHA: head }, "full-regression").status, 1);
    assert.strictEqual(r.run({ BASE_SHA: base, HEAD_SHA: base }, "full-regression").status, 0);
    assert.strictEqual(r.run({}, "full-regression").status, 0);
});

test("D7: post-merge mode fails the push that adds the D7 file, and passes its revert", () => {
    const r = repo();
    r.commit({ "a.txt": "a\n" });
    const merged = r.commit({ [`${P}factory_drill_post_merge.rs`]: "// drill\n" });
    assert.strictEqual(r.run({ HEAD_SHA: merged }, "post-merge").status, 1);
    const reverted = r.commit({}, [`${P}factory_drill_post_merge.rs`]);
    assert.strictEqual(r.run({ HEAD_SHA: reverted }, "post-merge").status, 0);
});
