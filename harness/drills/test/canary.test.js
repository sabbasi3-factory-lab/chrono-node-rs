"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const YAML = require("yaml");
const { verdict, WORKFLOWS, TASK } = require("../canary");

const ROOT = path.resolve(__dirname, "../../..");

test("canary inputs reach each workflow's contract check (run through its real validation step)", () => {
    for (const [name, w] of Object.entries(WORKFLOWS)) {
        const md = fs.readFileSync(path.join(ROOT, `.github/workflows/${name}.md`), "utf8");
        const fm = YAML.parse(/^---\n([\s\S]*?)\n---/.exec(md)[1]);
        assert.deepStrictEqual(Object.keys(fm.on.workflow_dispatch.inputs).sort(), Object.keys(w.inputs).sort(), `${name}: every input, no extra`);
        const run = fm["run-name"].replace(/\$\{\{ github\.event\.inputs\.([a-z_]+) \}\}/g, (_, k) => w.inputs[k]);
        assert.strictEqual(run, w.title, `${name}: run name`);
        const step = fm.steps.find((s) => s.name === w.validate);
        assert.ok(step, `${name}: validation step "${w.validate}"`);
        const env = { PATH: process.env.PATH, FACTORY_ENABLED: "true" };
        for (const [k, v] of Object.entries(step.env || {})) {
            const m = /^\$\{\{ github\.event\.inputs\.([a-z_]+) \}\}$/.exec(String(v));
            if (m) env[k] = w.inputs[m[1]] ?? "";
        }
        const r = spawnSync("bash", ["-e", "-c", step.run], { cwd: ROOT, env, encoding: "utf8" });
        assert.notStrictEqual(r.status, 0, `${name}: the sentinel task must be refused`);
        assert.match(r.stdout + r.stderr, new RegExp(`::error::no contract contracts/${TASK}\\.yaml`), `${name}: refused at the contract check, not before\n${r.stdout}${r.stderr}`);
    }
});

test("verdict: healthy only when activation passed and the agent stopped at its validation step", () => {
    const V = "Validate dispatch, PR head and contract";
    const agent = (failedAt, exec = "skipped") => ({ name: "agent", conclusion: "failure", steps: [{ name: "Checkout", conclusion: "success" }, { name: failedAt, conclusion: "failure" }, { name: "Execute GitHub Copilot CLI", conclusion: exec }] });
    const ok = [{ name: "activation", conclusion: "success", steps: [] }, agent(V)];
    assert.deepStrictEqual(verdict(ok, V).ok, true);
    // #393: review run 42171900921 failed in activation (E009 CONFIG_HASH_MISMATCH).
    const stale = [{ name: "activation", conclusion: "failure", steps: [{ name: "Check workflow lock file", conclusion: "failure" }] }, { name: "agent", conclusion: "skipped", steps: [] }];
    assert.deepStrictEqual(verdict(stale, V), { ok: false, why: 'activation failure at "Check workflow lock file"' });
    assert.match(verdict([ok[0], agent("Checkout")], V).why, /before its validation step/);
    assert.match(verdict([ok[0], { name: "agent", conclusion: "success", steps: [] }], V).why, /didn't refuse/);
    assert.match(verdict([ok[0], agent(V, "success")], V).why, /inference step success/);
    assert.match(verdict([], V).why, /no activation job/);
});
