#!/usr/bin/env node
"use strict";
// Factory v2 (docs/factory-v2.md): the agent's offline copy of the gates acceptance check for one
// language, run before opening or pushing a PR. Same code as the trusted gate (gates/scope.js
// unitReasons), on the working tree: every contract's scope file exists and has the `#[test]`
// functions its unit acceptance names. Advisory for the agent; gates still enforces from main.
//   node v2/check.js <lang>     prints "ok" or each missing item, exit 1
const fs = require("fs");
const path = require("path");
const YAML = require("yaml");
const { unitReasons } = require("../gates/scope");

const REPO = path.resolve(__dirname, "../..");

function check(unit, repo = REPO) {
    if (!/^[a-z]{2}(?:-[a-z]+)?$/.test(unit || "")) return [`invalid language ${JSON.stringify(unit)}`];
    const dir = path.join(repo, "contracts", unit);
    if (!fs.existsSync(dir)) return [`no contracts/${unit}/`];
    const reasons = [];
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".yaml")).sort()) {
        const contract = YAML.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        const scope = Array.isArray(contract.scope) ? contract.scope : [];
        const present = scope.filter((p) => fs.existsSync(path.join(repo, p)));
        for (const p of scope) if (!present.includes(p)) reasons.push(`${contract.id}: scope file ${p} is missing`);
        const readFile = (p) => (fs.existsSync(path.join(repo, p)) ? fs.readFileSync(path.join(repo, p), "utf8") : null);
        for (const r of unitReasons({ contract, changed: present, scope, readFile })) reasons.push(`${contract.id}: ${r}`);
    }
    return reasons;
}

module.exports = { check };

if (require.main === module) {
    const reasons = check(process.argv[2]);
    for (const r of reasons) console.log(r);
    if (reasons.length) process.exitCode = 1;
    else console.log("ok");
}
