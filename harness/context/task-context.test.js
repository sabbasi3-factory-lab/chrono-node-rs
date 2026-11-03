"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const YAML = require("yaml");
const { build } = require("./task-context");

const CONTRACTS = path.resolve(__dirname, "../../contracts");

function contractIds() {
    const ids = [];
    for (const dir of fs.readdirSync(CONTRACTS)) {
        for (const f of fs.readdirSync(path.join(CONTRACTS, dir))) if (f.endsWith(".yaml")) ids.push(`${dir}/${f.slice(0, -5)}`);
    }
    return ids.sort();
}

test("every contract gets a context with its source, all its golden cases and their upstream tests", () => {
    const ids = contractIds();
    assert.ok(ids.length > 0);
    for (const id of ids) {
        const contract = YAML.parse(fs.readFileSync(path.join(CONTRACTS, `${id}.yaml`), "utf8"));
        const text = build(id);
        assert.ok(text.includes(`## Upstream source: \`${contract.source}\``), id);
        const cases = text.split("\n").filter((l) => l.startsWith('{"id":')).map((l) => JSON.parse(l));
        assert.strictEqual(cases.length, contract.golden_cases, `${id}: golden case count`);
        const tests = text.slice(text.indexOf("## Upstream tests behind those cases"));
        for (const c of cases) assert.ok(tests.includes(`test(${JSON.stringify(c.upstream_test)}`), `${id}: test block for ${c.upstream_test}`);
    }
});

test("rejects a task id that could leave contracts/", () => {
    assert.throws(() => build("../x"), /invalid task id/);
    assert.throws(() => build("en/../../x"), /invalid task id/);
});
