#!/usr/bin/env node
"use strict";
// Writes the up-front task context for the `implement` workflow's `task_context: upfront`
// experiment variant. Deterministic: it only reads the repository.
//
//   node context/task-context.js <task-id> <out-file>
//
// The file holds, for one contract: the upstream source of the step, every golden case that needs
// the step (input and chrono-node's exact output), and the upstream test files those cases come from.
const fs = require("fs");
const path = require("path");
const YAML = require("yaml");

const REPO = path.resolve(__dirname, "../..");

function read(rel) {
    return fs.readFileSync(path.join(REPO, rel), "utf8");
}

/** A golden case without the fields every case shares (system time zone UTC, empty options). */
function compactCase(c) {
    const { system_timezone, options, ...rest } = c;
    return Object.keys(options).length ? { ...rest, options } : rest;
}

/** The top-level `test("<name>", ...)` blocks of an upstream test file whose name is in `names`. */
function testBlocks(source, names) {
    const blocks = [];
    let current = null;
    for (const line of source.split("\n")) {
        const m = /^test\(\s*(["'`])(.*?)\1/.exec(line);
        if (m) {
            current = { name: m[2], lines: [] };
            blocks.push(current);
        }
        if (current) current.lines.push(line);
    }
    return blocks
        .filter((b) => names.has(b.name))
        .map((b) => b.lines.join("\n").trimEnd())
        .join("\n\n");
}

function build(task) {
    if (!/^[a-z0-9-]+(\/[a-z0-9-]+)+$/.test(task)) throw new Error(`invalid task id ${JSON.stringify(task)}`);
    const contract = YAML.parse(read(`contracts/${task}.yaml`));
    const golden = contract.acceptance.find((a) => a.golden).golden;
    const index = JSON.parse(read("tests/golden/index.json"));

    const cases = [];
    const tests = new Map(); // upstream test file -> names of the tests behind those cases
    for (const area of golden.areas) {
        for (const c of JSON.parse(read(`tests/golden/${area}.json`)).cases) {
            if (![...c.requires.parsers, ...c.requires.refiners].includes(golden.step)) continue;
            cases.push(c);
            const file = index.files[area].source;
            if (!tests.has(file)) tests.set(file, new Set());
            tests.get(file).add(c.upstream_test);
        }
    }

    const fence = (lang, text) => "````" + lang + "\n" + text.replace(/\n$/, "") + "\n````\n";
    const out = [
        `# Task context: ${task} (${golden.step})`,
        "",
        "Generated from `upstream/` and `tests/golden/` at this commit, before the agent started.",
        "Expected values here are chrono-node's real output.",
        "",
        `## Upstream source: \`${contract.source}\``,
        "",
        fence("ts", read(contract.source)),
        `## Golden cases that need ${golden.step} (${cases.length})`,
        "",
        "One JSON object per line, as in `tests/golden/<area>.json`.",
        "",
        fence("jsonl", cases.map((c) => JSON.stringify(compactCase(c))).join("\n")),
        "## Upstream tests behind those cases",
        "",
        "Only the `test(...)` blocks that produced the cases above.",
        "",
    ];
    for (const [file, names] of [...tests].sort(([a], [b]) => (a < b ? -1 : 1))) {
        out.push(`### \`${file}\``, "", fence("ts", testBlocks(read(file), names)));
    }
    return out.join("\n");
}

function main() {
    const [task, outFile] = process.argv.slice(2);
    if (!task || !outFile) {
        console.error("usage: node context/task-context.js <task-id> <out-file>");
        process.exit(2);
    }
    const text = build(task);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, text);
    console.log(`wrote ${outFile} (${Buffer.byteLength(text)} bytes)`);
}

if (require.main === module) main();

module.exports = { build };
