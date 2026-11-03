"use strict";
// Runs the `implement` workflow's inline up-front task-context script (experiment task_context,
// variant upfront) exactly as written in .github/workflows/implement.md, for every contract.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const YAML = require("yaml");

const HARNESS = path.resolve(__dirname, "../..");
const REPO = path.resolve(HARNESS, "..");

function inlineScript() {
    const lines = fs.readFileSync(path.join(REPO, ".github/workflows/implement.md"), "utf8").split("\n");
    const start = lines.findIndex((l) => l.trim() === "node - <<'JS'");
    const end = lines.findIndex((l, i) => i > start && l.trim() === "JS");
    assert.ok(start >= 0 && end > start, "inline task-context script not found in implement.md");
    const indent = lines[start].match(/^ */)[0].length;
    return lines.slice(start + 1, end).map((l) => l.slice(indent)).join("\n");
}

function run(task, out) {
    return spawnSync(process.execPath, ["-"], { cwd: HARNESS, input: inlineScript(), env: { ...process.env, TASK: task, OUT: out }, encoding: "utf8" });
}

test("every contract gets a context with its source, all its golden cases and their upstream tests", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-context-"));
    try {
        const contracts = path.join(REPO, "contracts");
        const ids = fs.readdirSync(contracts).flatMap((d) => fs.readdirSync(path.join(contracts, d)).filter((f) => f.endsWith(".yaml")).map((f) => `${d}/${f.slice(0, -5)}`));
        assert.ok(ids.length > 0);
        for (const id of ids.sort()) {
            const out = path.join(dir, `${id.replace("/", "_")}.md`);
            const res = run(id, out);
            assert.strictEqual(res.status, 0, `${id}: ${res.stderr}`);
            const contract = YAML.parse(fs.readFileSync(path.join(contracts, `${id}.yaml`), "utf8"));
            const text = fs.readFileSync(out, "utf8");
            assert.ok(text.includes(`## Upstream source: \`${contract.source}\``), id);
            const cases = text.split("\n").filter((l) => l.startsWith('{"id":')).map((l) => JSON.parse(l));
            assert.strictEqual(cases.length, contract.golden_cases, `${id}: golden case count`);
            const tests = text.slice(text.indexOf("## Upstream tests behind those cases"));
            for (const c of cases) assert.ok(tests.includes(`test(${JSON.stringify(c.upstream_test)}`), `${id}: test block for ${c.upstream_test}`);
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("rejects a task id that could leave contracts/", () => {
    for (const bad of ["../x", "en/../../x"]) {
        const res = run(bad, path.join(os.tmpdir(), "unused.md"));
        assert.notStrictEqual(res.status, 0);
        assert.match(res.stderr, /invalid task id/);
    }
});
