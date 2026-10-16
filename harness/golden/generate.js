#!/usr/bin/env node
"use strict";
// Golden-test generator.
//
//   node golden/generate.js           regenerate tests/golden/{core,en}/*.json
//   node golden/generate.js --check   regenerate into a temp dir and fail if tests/golden differs
//
// Runs chrono-node's own core and English tests from upstream/ under jest, with TZ=UTC and a
// frozen "now", and records every parse call plus chrono-node's real output (see setup.js).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const HARNESS = path.resolve(__dirname, "..");
const REPO = path.resolve(HARNESS, "..");
const GOLDEN = path.join(REPO, "tests/golden");
const AREAS = ["core", "en"];

// Used only where an upstream test passes no reference date.
const DEFAULT_REFERENCE = "2012-08-10T12:00:00.000Z";
const SYSTEM_TIMEZONE = "UTC";
const SCHEMA = 1;

function upstreamPin() {
    const pinned = fs.readFileSync(path.join(REPO, "upstream/PINNED.md"), "utf8");
    const commit = /\| Commit \| `([0-9a-f]{40})` \|/.exec(pinned)?.[1];
    const version = JSON.parse(fs.readFileSync(path.join(REPO, "upstream/package.json"), "utf8")).version;
    if (!commit) throw new Error("upstream/PINNED.md has no commit SHA");
    return { version, commit };
}

/** upstream/test/en/en_weekday.test.ts -> en/weekday ; upstream/test/system.test.ts -> core/system */
function areaOf(source) {
    const rel = source.replace(/^test\//, "").replace(/\.test\.ts$/, "");
    const parts = rel.split("/");
    if (parts.length === 1) return `core/${parts[0]}`;
    const [lang, name] = parts;
    const short = name.startsWith(`${lang}_`) ? name.slice(lang.length + 1) : name === lang ? "general" : name;
    return `${lang}/${short}`;
}

function runJest(rawDir) {
    const jestBin = path.join(HARNESS, "node_modules/jest/bin/jest.js");
    if (!fs.existsSync(jestBin)) throw new Error("run `npm ci` in harness/ first");
    const res = spawnSync(
        process.execPath,
        [jestBin, "--config", path.join(__dirname, "jest.config.js"), "--runInBand", "--ci", "--silent"],
        {
            cwd: HARNESS,
            stdio: ["ignore", "inherit", "inherit"],
            env: {
                ...process.env,
                TZ: SYSTEM_TIMEZONE,
                GOLDEN_RAW_DIR: rawDir,
                GOLDEN_DEFAULT_REFERENCE: DEFAULT_REFERENCE,
            },
        }
    );
    if (res.status !== 0) throw new Error(`upstream tests failed under TZ=UTC (jest exit ${res.status})`);
}

function caseKey(c) {
    return JSON.stringify([c.config, c.text, c.reference, c.options]);
}

function build(outDir) {
    const rawDir = fs.mkdtempSync(path.join(os.tmpdir(), "golden-raw-"));
    try {
        runJest(rawDir);
        const pin = upstreamPin();
        const files = new Map();
        const index = { schema: SCHEMA, upstream: pin, system_timezone: SYSTEM_TIMEZONE, default_reference: DEFAULT_REFERENCE, files: {} };
        const problems = [];

        for (const name of fs.readdirSync(rawDir).sort()) {
            if (!name.endsWith(".json")) continue;
            const raw = JSON.parse(fs.readFileSync(path.join(rawDir, name), "utf8"));
            problems.push(...raw.errors.map((e) => ({ source: raw.source, ...e })));
            const area = areaOf(raw.source);
            const seen = new Set();
            const cases = [];
            for (const c of raw.cases) {
                const key = caseKey(c);
                if (seen.has(key)) continue;
                seen.add(key);
                cases.push(c);
            }
            if (cases.length === 0) {
                index.files[area] = { source: `upstream/${raw.source}`, cases: 0, skipped: raw.skipped.length };
                continue;
            }
            const width = String(cases.length).length;
            const withIds = cases.map((c, i) => ({ id: `${area}#${String(i + 1).padStart(width, "0")}`, ...c }));
            files.set(area, {
                schema: SCHEMA,
                generator: "harness/golden/generate.js",
                upstream: pin,
                source: `upstream/${raw.source}`,
                cases: withIds,
            });
            const skippedByReason = {};
            for (const s of raw.skipped) skippedByReason[s.reason] = (skippedByReason[s.reason] ?? 0) + 1;
            index.files[area] = {
                source: `upstream/${raw.source}`,
                cases: withIds.length,
                skipped: raw.skipped.length,
                skipped_by_reason: skippedByReason,
            };
        }
        if (problems.length > 0) {
            for (const p of problems) console.error(JSON.stringify(p));
            throw new Error(`${problems.length} recording problem(s); see above`);
        }

        for (const area of AREAS) fs.rmSync(path.join(outDir, area), { recursive: true, force: true });
        for (const [area, data] of files) {
            const file = path.join(outDir, `${area}.json`);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
        }
        const sortedFiles = {};
        for (const k of Object.keys(index.files).sort()) sortedFiles[k] = index.files[k];
        index.files = sortedFiles;
        fs.writeFileSync(path.join(outDir, "index.json"), JSON.stringify(index, null, 2) + "\n");
        const configurations = JSON.parse(fs.readFileSync(path.join(rawDir, "..configurations"), "utf8"));
        const sortedConfigs = {};
        for (const k of Object.keys(configurations).sort()) sortedConfigs[k] = configurations[k];
        fs.writeFileSync(
            path.join(outDir, "configurations.json"),
            JSON.stringify({ schema: SCHEMA, upstream: pin, configurations: sortedConfigs }, null, 2) + "\n"
        );
        return index;
    } finally {
        fs.rmSync(rawDir, { recursive: true, force: true });
    }
}

function listFiles(dir) {
    const out = [];
    const walk = (d) => {
        if (!fs.existsSync(d)) return;
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith(".json")) out.push(path.relative(dir, p));
        }
    };
    walk(dir);
    return out.sort();
}

function main() {
    const check = process.argv.includes("--check");
    if (!check) {
        const index = build(GOLDEN);
        const total = Object.values(index.files).reduce((n, f) => n + f.cases, 0);
        console.log(`wrote ${Object.keys(index.files).length} areas, ${total} cases to tests/golden/`);
        return;
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "golden-check-"));
    try {
        build(tmp);
        const committed = listFiles(GOLDEN).filter(
            (f) => f === "index.json" || f === "configurations.json" || AREAS.some((a) => f.startsWith(a + path.sep))
        );
        const fresh = listFiles(tmp);
        const diffs = [];
        for (const f of new Set([...committed, ...fresh])) {
            const a = fs.existsSync(path.join(GOLDEN, f)) ? fs.readFileSync(path.join(GOLDEN, f), "utf8") : null;
            const b = fs.existsSync(path.join(tmp, f)) ? fs.readFileSync(path.join(tmp, f), "utf8") : null;
            if (a !== b) diffs.push(f);
        }
        if (diffs.length > 0) {
            console.error(`tests/golden is out of date with upstream/ + harness/: ${diffs.join(", ")}`);
            process.exit(1);
        }
        console.log("tests/golden matches a fresh generation");
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

main();
