#!/usr/bin/env node
"use strict";
// Upstream sync (DESIGN §6 "version sync"). Deterministic; no AI. A port has to follow its source:
// this notices a new chrono-node release and says what it changes for us.
//
//   node upstream.js check [--pinned-tag vX.Y.Z]   compare the newest chrono-node release with
//                                                  upstream/PINNED.md; writes upstream-report.json
//                                                  and upstream-issue.md (--pinned-tag: drill)
//   node upstream.js issue --report FILE           (live) open the one issue for that version,
//                                                  or do nothing if it exists (any state)
//   node upstream.js stage --report FILE --from DIR   replace upstream/ with the new release's
//                                                  files (DIR = its extracted tarball) and update
//                                                  PINNED.md; the workflow then regenerates
//                                                  tests/golden and contracts for the bump PR
//
// Reads only public GitHub data (wanasit/chrono): releases and the compare API.
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "../..");
const UPSTREAM_REPO = "wanasit/chrono";
const SLUG = process.env.GITHUB_REPOSITORY || "sabbasi3-factory-lab/chrono-node-rs";
// A drill's issue gets its own marker, so it never stands in for the real issue of that version.
const MARKER = (tag, drill = false) => `<!-- factory-upstream${drill ? "-drill" : ""}: ${tag} -->`;
// Copied from upstream (upstream/PINNED.md "What is here").
const COPIED = ["src", "test", "LICENSE.txt", "README.md", "package.json", "package-lock.json", "tsconfig.json", "tsconfig.build.json", "tsconfig.build.esm.json"];

const opt = (name) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : null;
};

async function gh(method, apiPath, body) {
    const headers = { accept: "application/vnd.github+json", "content-type": "application/json" };
    if (process.env.GH_TOKEN) headers.authorization = `Bearer ${process.env.GH_TOKEN}`;
    const res = await fetch(`https://api.github.com${apiPath}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) throw new Error(`${method} ${apiPath}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.json();
}

/** upstream/PINNED.md → {tag, commit}. */
function pinned(text) {
    const tag = /\| Version \| `(v\d+\.\d+\.\d+)` \|/.exec(text)?.[1];
    const commit = /\| Commit \| `([0-9a-f]{40})` \|/.exec(text)?.[1];
    if (!tag || !commit) throw new Error("upstream/PINNED.md has no Version/Commit");
    return { tag, commit };
}

const semver = (tag) => tag.replace(/^v/, "").split(".").map(Number);
const newer = (a, b) => {
    const [x, y] = [semver(a), semver(b)];
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
    return false;
};

/** upstream/test/en/en_weekday.test.ts → en/weekday (as harness/golden/generate.js names areas). */
function areaOf(file) {
    const rel = file.replace(/^test\//, "").replace(/\.test\.ts$/, "");
    const parts = rel.split("/");
    if (parts.length === 1) return `core/${parts[0]}`;
    const [lang, name] = parts;
    return `${lang}/${name.startsWith(`${lang}_`) ? name.slice(lang.length + 1) : name === lang ? "general" : name}`;
}

/**
 * What the changed upstream files mean for the port. Pure.
 * @param files    [{filename, status, previous_filename?}] from the compare API (upstream repo paths)
 * @param taskmap  scripts/seed-backlog/taskmap.yaml
 * @param ported   language codes with a Rust src/locales/<lang>/
 */
function summarize(files, taskmap, ported) {
    const bySource = new Map();
    for (const t of taskmap.tasks || []) bySource.set(`src/${t.source}`, { step: t.step, task: t.id });
    const done = new Set((taskmap.done || []).map((d) => d.step));
    const out = { steps: [], new_steps: [], removed_steps: [], configuration: [], core: [], tests: [], unported: [], other: [] };
    for (const f of files) {
        const p = f.filename;
        const lang = /^src\/locales\/([a-z]{2})\//.exec(p)?.[1] || /^test\/([a-z]{2})\//.exec(p)?.[1] || null;
        if (lang && !ported.includes(lang)) {
            out.unported.push(p);
            continue;
        }
        if (/^src\/(locales\/[a-z]{2}|common)\/(parsers|refiners)\/[^/]+\.ts$/.test(p) && !path.basename(p).startsWith("Abstract")) {
            const step = path.basename(p, ".ts");
            const known = bySource.get(p) || (done.has(step) ? { step, task: null } : null);
            if (f.status === "removed") out.removed_steps.push({ file: p, ...(known || { step }) });
            else if (known) out.steps.push({ file: p, status: f.status, ...known });
            else out.new_steps.push({ file: p, status: f.status, step });
        } else if (/^src\/locales\/[a-z]{2}\/(configuration|index)\.ts$/.test(p) || p === "src/configurations.ts") {
            out.configuration.push(p);
        } else if (p.startsWith("src/")) {
            out.core.push(p);
        } else if (/^test\/.*\.test\.ts$/.test(p)) {
            out.tests.push({ file: p, area: areaOf(p), status: f.status });
        } else {
            out.other.push(p);
        }
    }
    return out;
}

function renderIssue(r) {
    const s = r.summary;
    const code = (x) => `\`${x}\``;
    const list = (items, fmt) => (items.length ? items.map((x) => `- ${fmt(x)}`).join("\n") : "- none");
    return [
        MARKER(r.latest.tag, r.drill),
        ...(r.drill ? [`> **Drill:** the pin was treated as ${r.pinned.tag}; nothing new was released.`, ""] : []),
        `chrono-node **${r.latest.tag}** is out (${r.latest.published_at.slice(0, 10)}); the port is pinned to **${r.pinned.tag}**.`,
        "",
        `- Release: https://github.com/${UPSTREAM_REPO}/releases/tag/${r.latest.tag}`,
        `- Diff: https://github.com/${UPSTREAM_REPO}/compare/${r.pinned.commit}...${r.latest.commit} (${r.files} files${r.truncated ? ", truncated at 300: see the link" : ""})`,
        ...(r.skipped.length ? [`- Also released since the pin: ${r.skipped.join(", ")}`] : []),
        "",
        "### Ported steps that changed (their contracts and golden areas)",
        list(s.steps, (x) => `${code(x.file)} (${x.status}) → ${x.task ? `task ${code(x.task)}` : `${code(x.step)} (ported in Stage 0)`}`),
        "",
        "### New steps (need a task map entry)",
        list(s.new_steps, (x) => `${code(x.file)} → ${code(x.step)}`),
        "",
        "### Removed steps",
        list(s.removed_steps, (x) => `${code(x.file)}${x.task ? ` (task ${code(x.task)})` : ""}`),
        "",
        "### Configurations (step order, named configurations)",
        list(s.configuration, code),
        "",
        "### Core and shared bases (hand-ported: results, calculation, chrono, timezone, utils, Abstract* steps)",
        list(s.core, code),
        "",
        "### Upstream tests (golden areas)",
        list(s.tests, (x) => `${code(x.file)} (${x.status}) → ${code(x.area)}`),
        "",
        `### Languages not ported yet (${s.unported.length} files, no action)`,
        "",
        "### Next",
        "",
        "The bump is a human-tier PR (`upstream/`, `tests/golden/`, `contracts/`): re-copy `upstream/` from the tag, regenerate `tests/golden/`, re-run the seed script (new `source_sha` on every contract; new steps need task map entries). The `upstream-sync` workflow drafts it when this issue is labelled `upstream:bump`.",
        "",
        "_Filed by the upstream sync (plain code, no AI)._",
    ].join("\n");
}

async function check() {
    const pin = pinned(fs.readFileSync(path.join(REPO, "upstream/PINNED.md"), "utf8"));
    // Drill: pretend the pin is an older release, so the current one looks new.
    const drillTag = opt("--pinned-tag");
    const from = drillTag ? { tag: drillTag, commit: (await gh("GET", `/repos/${UPSTREAM_REPO}/commits/${drillTag}`)).sha } : pin;
    const releases = (await gh("GET", `/repos/${UPSTREAM_REPO}/releases?per_page=30`)).filter((r) => !r.draft && !r.prerelease && /^v\d+\.\d+\.\d+$/.test(r.tag_name));
    const latest = releases.reduce((a, r) => (a === null || newer(r.tag_name, a.tag_name) ? r : a), null);
    const report = { pinned: from, drill: Boolean(drillTag), status: "up_to_date", latest: latest ? { tag: latest.tag_name } : null };
    if (latest && newer(latest.tag_name, from.tag)) {
        const commit = (await gh("GET", `/repos/${UPSTREAM_REPO}/commits/${latest.tag_name}`)).sha;
        const cmp = await gh("GET", `/repos/${UPSTREAM_REPO}/compare/${from.commit}...${commit}?per_page=300`);
        // Loaded here only: `issue` runs with a write token and must load no third-party module.
        const taskmap = require("yaml").parse(fs.readFileSync(path.join(__dirname, "taskmap.yaml"), "utf8"));
        const ported = fs.readdirSync(path.join(REPO, "src/locales"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
        Object.assign(report, {
            status: "new_version",
            latest: { tag: latest.tag_name, commit, published_at: latest.published_at },
            skipped: releases.filter((r) => newer(r.tag_name, from.tag) && r.tag_name !== latest.tag_name).map((r) => r.tag_name).sort(),
            files: (cmp.files || []).length,
            truncated: (cmp.files || []).length >= 300,
            summary: summarize(cmp.files || [], taskmap, ported),
        });
        fs.writeFileSync("upstream-issue.md", renderIssue(report) + "\n");
    }
    fs.writeFileSync("upstream-report.json", JSON.stringify(report, null, 2) + "\n");
    console.log(report.status === "new_version" ? `new chrono-node ${report.latest.tag} (pinned ${from.tag})` : `up to date (${from.tag})`);
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `status=${report.status}\ntag=${report.latest ? report.latest.tag : ""}\n`);
}

/** One issue per upstream version, ever: an existing one (open or closed) with the marker wins. */
async function issue() {
    const r = JSON.parse(fs.readFileSync(opt("--report"), "utf8"));
    if (r.status !== "new_version") return console.log("nothing to file");
    const marker = MARKER(r.latest.tag, r.drill);
    for (let page = 1; ; page++) {
        const batch = await gh("GET", `/repos/${SLUG}/issues?labels=upstream&state=all&per_page=100&page=${page}`);
        const found = batch.find((i) => (i.body || "").includes(marker));
        if (found) return console.log(`already filed: #${found.number}`);
        if (batch.length < 100) break;
    }
    const body = fs.readFileSync("upstream-issue.md", "utf8");
    const created = await gh("POST", `/repos/${SLUG}/issues`, { title: `${r.drill ? "[drill] " : ""}Upstream: chrono-node ${r.latest.tag} (pinned ${r.pinned.tag})`, body, labels: r.drill ? ["upstream", "drill"] : ["upstream"] });
    console.log(`opened #${created.number}`);
}

/** Replace upstream/ with the release's files (the same list as PINNED.md), and update the pin. */
function stage() {
    const r = JSON.parse(fs.readFileSync(opt("--report"), "utf8"));
    const from = path.resolve(opt("--from"));
    if (r.status !== "new_version" || !/^v\d+\.\d+\.\d+$/.test(r.latest.tag) || !/^[0-9a-f]{40}$/.test(r.latest.commit)) throw new Error("no new version to stage");
    for (const name of COPIED) {
        const src = path.join(from, name);
        const dst = path.join(REPO, "upstream", name);
        if (!fs.existsSync(src)) throw new Error(`the release has no ${name}`);
        fs.rmSync(dst, { recursive: true, force: true });
        fs.cpSync(src, dst, { recursive: true, verbatimSymlinks: true });
    }
    const pinnedFile = path.join(REPO, "upstream/PINNED.md");
    const text = fs.readFileSync(pinnedFile, "utf8");
    const old = pinned(text);
    fs.writeFileSync(pinnedFile, text.replace(`| Version | \`${old.tag}\` |`, `| Version | \`${r.latest.tag}\` |`).replace(`| Commit | \`${old.commit}\` |`, `| Commit | \`${r.latest.commit}\` |`));
    console.log(`upstream/ staged at ${r.latest.tag} (${r.latest.commit})`);
}

module.exports = { pinned, newer, areaOf, summarize, renderIssue, MARKER };

if (require.main === module) {
    const commands = { check, issue, stage };
    const cmd = commands[process.argv[2]];
    if (!cmd) {
        console.error(`usage: upstream.js ${Object.keys(commands).join("|")} ...`);
        process.exit(2);
    }
    Promise.resolve(cmd()).catch((e) => {
        console.error(e.message);
        process.exitCode = 1;
    });
}
