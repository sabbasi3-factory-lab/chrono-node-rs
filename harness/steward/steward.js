#!/usr/bin/env node
"use strict";
// Dependency steward (DESIGN §9; factory policies/dependencies.yaml). Plain code, no AI.
//
//   node steward/steward.js authorize --event EVENT.json [--approval true]   the labeller: the agent App or write access (approvals: write access only)
//   node steward/steward.js check --event EVENT.json --out DIR [--approved]
//                                       facts + verdict → DIR/decision.json (no token; runs cargo add,
//                                       cargo metadata and cargo deny in this checkout, which run no crate code)
//   node steward/steward.js comment --issue N --out DIR [--pr M]  (live) comment, label, close
//   node steward/steward.js sweep                                  (live) reject borderline requests after 24 h
//
// See README.md. The write commands load no third-party module.
const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const lib = require("./lib");

const REPO_DIR = path.resolve(__dirname, "../..");
const REPO = process.env.GITHUB_REPOSITORY || "sabbasi3-factory-lab/chrono-node-rs";
const AGENT_BOT = "sabbasi3-factory-agent[bot]";
const CONTROLLER_BOT = "sabbasi3-factory-controller[bot]";
const UA = { "user-agent": "chrono-node-rs dependency steward (https://github.com/sabbasi3-factory-lab/chrono-node-rs)" };
const AUDITS = {
    mozilla: "https://raw.githubusercontent.com/mozilla/supply-chain/main/audits.toml",
    google: "https://raw.githubusercontent.com/google/supply-chain/main/audits.toml",
    "bytecode-alliance": "https://raw.githubusercontent.com/bytecodealliance/wasmtime/main/supply-chain/audits.toml",
};
const HEAD = "**Dependency steward** (plain code, no AI)";

const opt = (name) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : null;
};
const writeJson = (file, v) => fs.writeFileSync(file, JSON.stringify(v, null, 2) + "\n");

async function gh(method, apiPath, body) {
    const res = await fetch(`https://api.github.com${apiPath}`, {
        method,
        headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: "application/vnd.github+json", "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404 && method === "GET") return null;
    if (!res.ok) throw new Error(`${method} ${apiPath}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.status === 204 ? null : res.json();
}

async function getJson(url) {
    const res = await fetch(url, { headers: UA });
    if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
    return res.json();
}

async function authorize() {
    const event = JSON.parse(fs.readFileSync(opt("--event"), "utf8"));
    const login = event.sender && event.sender.login;
    // An approval of a borderline request must come from a person with write access, never an App.
    const approval = opt("--approval") === "true";
    let ok = !approval && (login === AGENT_BOT || login === CONTROLLER_BOT);
    if (!ok && login) {
        const p = await gh("GET", `/repos/${REPO}/collaborators/${encodeURIComponent(login)}/permission`);
        ok = Boolean(p && ["admin", "maintain", "write"].includes(p.permission));
    }
    console.log(`${login}: ${ok ? "may request dependencies" : "no write access"}`);
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `authorized=${ok}\n`);
}

/** The pinned dependency policy (factory repo at .github/factory/factory-version). */
async function loadPolicy() {
    const version = fs.readFileSync(path.join(REPO_DIR, ".github/factory/factory-version"), "utf8").trim();
    if (!/^[0-9a-f]{40}$/.test(version)) throw new Error("bad .github/factory/factory-version");
    const res = await fetch(`https://raw.githubusercontent.com/sabbasi3-factory-lab/factory/${version}/policies/dependencies.yaml`);
    if (!res.ok) throw new Error(`cannot load policies/dependencies.yaml: ${res.status}`);
    const p = require("yaml").parse(await res.text());
    const h = p && p.hard_checks;
    const s = p && p.soft_checks;
    if (!h || !Array.isArray(h.licence_allowlist) || !Array.isArray(h.denylist) || !s || !Number.isFinite(s.min_downloads) || !p.preapproved) {
        throw new Error("policies/dependencies.yaml is missing hard_checks, soft_checks or preapproved");
    }
    return { version, policy: p };
}

/** name@version pairs in a Cargo.lock. */
function lockPackages(text) {
    const out = [];
    for (const m of text.matchAll(/^\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"/gm)) out.push(`${m[1]}@${m[2]}`);
    return out;
}

const run = (cmd, args) => execFileSync(cmd, args, { cwd: REPO_DIR, encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] });

async function check() {
    const out = opt("--out");
    fs.mkdirSync(out, { recursive: true });
    const event = JSON.parse(fs.readFileSync(opt("--event"), "utf8"));
    const req = lib.parseRequest(event.issue.body || "");
    if (req.error) return writeJson(path.join(out, "decision.json"), { verdict: "invalid", error: req.error });
    const { version: factoryVersion, policy } = await loadPolicy();

    const manifest = fs.readFileSync(path.join(REPO_DIR, "Cargo.toml"), "utf8");
    const before = new Set(lockPackages(fs.readFileSync(path.join(REPO_DIR, "Cargo.lock"), "utf8")));
    const section = req.kind === "dev" ? "dev-dependencies" : "dependencies";
    const table = (manifest.split(/^\[/m).find((t) => t.startsWith(`${section}]`)) || "").split("\n").slice(1);
    if (table.some((l) => lib.norm(l.split("=")[0].trim()) === lib.norm(req.crate))) {
        return writeJson(path.join(out, "decision.json"), { verdict: "already", request: req });
    }

    // The denylist and near misses are rejected before anything is resolved (they may not even resolve).
    const popular = [];
    for (const page of [1, 2]) popular.push(...(await getJson(`https://crates.io/api/v1/crates?sort=downloads&per_page=100&page=${page}`)).crates.map((c) => c.id));
    if (policy.hard_checks.denylist.map(lib.norm).includes(lib.norm(req.crate))) {
        return writeJson(path.join(out, "decision.json"), { verdict: "fail", request: req, hard: ["denylist"], soft: [], waived: [] });
    }
    const miss = policy.hard_checks.typosquat_check ? lib.nearMiss(req.crate, [...popular, ...Object.values(policy.preapproved).flat(), ...policy.hard_checks.denylist]) : null;
    if (miss) return writeJson(path.join(out, "decision.json"), { verdict: "fail", request: req, hard: [`typosquat:${miss}`], soft: [], waived: [] });

    // cargo add + metadata resolve and download; neither runs any crate code.
    const add = spawnSync("cargo", ["add", `${req.crate}@${req.version}`, ...(req.kind === "dev" ? ["--dev"] : [])], { cwd: REPO_DIR, encoding: "utf8" });
    if (add.status !== 0) return writeJson(path.join(out, "decision.json"), { verdict: "fail", request: req, hard: ["not_resolvable"], soft: [], waived: [] });
    const meta = JSON.parse(run("cargo", ["metadata", "--format-version", "1"]));
    const afterList = lockPackages(fs.readFileSync(path.join(REPO_DIR, "Cargo.lock"), "utf8"));
    const after = new Set(afterList);
    const newOnes = afterList.filter((p) => !before.has(p));
    // Locked packages the addition moved or removed (it should only add).
    const changed = [...new Set([...before].filter((p) => !after.has(p)).map((p) => p.split("@")[0]))].sort();
    const byId = new Map(meta.packages.map((p) => [`${p.name}@${p.version}`, p]));
    const root = meta.packages.find((p) => p.name === "chrono-node-rs");
    const dep = root.dependencies.find((d) => lib.norm(d.name) === lib.norm(req.crate));
    const resolvedPkg = meta.packages.find((p) => lib.norm(p.name) === lib.norm(req.crate) && dep && p.source && after.has(`${p.name}@${p.version}`));
    if (!resolvedPkg) throw new Error("the added crate isn't in cargo metadata");
    const newPackages = newOnes.map((id) => {
        const p = byId.get(id);
        const buildDeps = p.dependencies.filter((d) => d.kind === "build").map((d) => d.name);
        const script = p.targets.find((t) => t.kind.includes("custom-build"));
        const source = script ? fs.readFileSync(script.src_path, "utf8") : "";
        return { name: p.name, version: p.version, licence: p.license, native: lib.isNative(p.links, buildDeps), build_script_network: script ? lib.buildScriptNetwork(source, buildDeps) : false, build_script: Boolean(script) };
    });

    // crates.io: the crate's trust signals and the resolved version's own record.
    const info = await getJson(`https://crates.io/api/v1/crates/${encodeURIComponent(resolvedPkg.name)}`);
    const v = info.versions.find((x) => x.num === resolvedPkg.version);
    const releases = info.versions.filter((x) => !x.yanked).map((x) => Date.parse(x.created_at));
    let isAudited = false;
    const auditSources = [];
    for (const [who, url] of Object.entries(AUDITS)) {
        if (!(policy.trusted_audits || []).includes(who)) continue;
        try {
            const res = await fetch(url);
            if (res.ok && lib.audited(await res.text(), resolvedPkg.name, resolvedPkg.version, req.kind)) {
                isAudited = true;
                auditSources.push(who);
            }
        } catch {
            // unreachable audit source: no waiver from it (fail towards borderline)
        }
    }

    // cargo deny with the trusted deny.toml (this checkout is main): licences, RustSec advisories (incl. yanked), bans, sources.
    const deny = spawnSync("cargo", ["deny", "--all-features", "check", "advisories", "bans", "licenses", "sources"], { cwd: REPO_DIR, encoding: "utf8" });
    const denyCodes = [...new Set([...(deny.stderr || "").matchAll(/error\[([a-z0-9-]+)\]/g)].map((m) => m[1]))].sort();

    const facts = {
        request: req,
        resolved: { name: resolvedPkg.name, version: resolvedPkg.version, licence: resolvedPkg.license, yanked: Boolean(v && v.yanked) },
        crate: { created_at: info.crate.created_at, downloads: info.crate.downloads, newest_release_at: new Date(Math.max(...releases)).toISOString() },
        new_packages: newPackages,
        changed_locked: changed,
        deny: { ok: deny.status === 0, failures: denyCodes },
        popular,
        audited: isAudited,
        already: false,
        now: new Date(),
    };
    const d = lib.decide(facts, policy);
    // An owner's approval (`dependency:approved`) accepts soft failures, never hard ones.
    const verdict = opt("--approved") === "true" && d.verdict === "borderline" ? "pass" : d.verdict;
    const decision = {
        verdict,
        approved: verdict !== d.verdict,
        request: req,
        resolved: facts.resolved,
        crate: facts.crate,
        new_packages: newPackages.map(({ name, version, licence, build_script, native }) => ({ name, version, licence, build_script, native })),
        audited_by: auditSources,
        hard: d.hard,
        soft: d.soft,
        waived: d.waived,
        factory_version: factoryVersion,
    };
    writeJson(path.join(out, "decision.json"), decision);
    console.log(JSON.stringify({ verdict, hard: d.hard, soft: d.soft, waived: d.waived }));
}

// ---- writes (live): fixed templates; the decision is re-validated, since it comes from a job that resolved third-party crates

const SAFE = /^[A-Za-z0-9._:+@/-]{1,120}$/;
function checkDecision(d) {
    const bad = () => {
        throw new Error("decision.json isn't a valid steward decision");
    };
    if (!d || !["pass", "borderline", "fail", "invalid", "already"].includes(d.verdict)) bad();
    if (d.verdict === "invalid") return Object.values(lib.ERRORS).includes(d.error) ? { verdict: "invalid", error: d.error } : bad();
    const r = d.request || {};
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(r.crate || "") || !/^\d+(\.\d+){0,2}$/.test(r.version || "") || !["runtime", "dev"].includes(r.kind)) bad();
    const list = (x) => (Array.isArray(x) && x.every((s) => typeof s === "string" && SAFE.test(s)) ? x : bad());
    if (d.verdict === "already") return { verdict: "already", request: r };
    const resolved = d.resolved && SAFE.test(d.resolved.name || "") && /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(d.resolved.version || "") ? d.resolved : d.verdict === "fail" ? null : bad();
    return { verdict: d.verdict, approved: d.approved === true, request: r, resolved, hard: list(d.hard || []), soft: list(d.soft || []), waived: list(d.waived || []) };
}

const EXPLAIN = {
    denylist: "on the denylist (competing natural-language date crates)",
    typosquat: "a near miss of the popular crate",
    licence: "a licence outside the allowlist in",
    yanked: "the resolved version is yanked",
    cargo_deny: "cargo deny failed:",
    build_script_network: "a build script that uses the network in",
    not_resolvable: "no published version matches the request",
    min_crate_age_days: "the crate is younger than the policy's minimum age",
    min_downloads: "fewer downloads than the policy's minimum",
    max_months_since_release: "no release within the policy's window",
    max_new_transitive: "more new transitive crates than the policy allows",
    native_code: "a new crate builds or links native (C/C++) code",
    changes_locked_versions: "adding it changes versions already locked",
};
const explain = (code) => {
    const [k, arg] = code.split(":");
    return `\`${code}\`: ${EXPLAIN[k] || k}${arg ? ` \`${arg}\`` : ""}`;
};

async function comment() {
    const issue = Number(opt("--issue"));
    const pr = opt("--pr");
    const d = checkDecision(JSON.parse(fs.readFileSync(path.join(opt("--out"), "decision.json"), "utf8")));
    const post = (body) => gh("POST", `/repos/${REPO}/issues/${issue}/comments`, { body });
    const label = (labels) => gh("POST", `/repos/${REPO}/issues/${issue}/labels`, { labels });
    const close = (state_reason) => gh("PATCH", `/repos/${REPO}/issues/${issue}`, { state: "closed", state_reason });
    if (d.verdict === "invalid") return post(`${HEAD} · can't check\n\n${d.error}. Fix the issue (the dependency request form's headings), then remove and re-add \`dependency-request\`.`);
    if (d.verdict === "already") {
        await post(`${HEAD} · already a dependency\n\n\`${d.request.crate}\` is already in Cargo.toml (${d.request.kind}). Closing.`);
        return close("not_planned");
    }
    const waived = d.waived.length ? `\n\nWaived: ${d.waived.map((w) => `\`${w}\``).join(", ")}.` : "";
    if (d.verdict === "fail") {
        await post(`${HEAD} · rejected\n\nHard checks failed (policies/dependencies.yaml):\n${d.hard.map((c) => `- ${explain(c)}`).join("\n")}\n\nSolve the task with the crates that are already approved. Closing.`);
        await label(["dependency:rejected"]);
        return close("not_planned");
    }
    if (d.verdict === "borderline") {
        await post(
            `${HEAD} · borderline: the owner decides\n\nEvery hard check passed; these soft checks didn't:\n${d.soft.map((c) => `- ${explain(c)}`).join("\n")}${waived}\n\nSomeone with write access can add \`dependency:approved\` to accept it. Without that it's rejected automatically after 24 hours (limits.yaml borderline_dependency).`,
        );
        return label(["dependency:borderline", "needs-human"]);
    }
    if (!/^[1-9]\d*$/.test(pr || "")) throw new Error("--pr is required for a pass");
    await post(`${HEAD} · ${d.approved ? "approved by the owner" : "passed"}\n\n\`${d.resolved.name} ${d.resolved.version}\` (${d.request.kind}) passed every hard check${d.approved ? "; the owner accepted the soft ones" : " and soft check"}.${waived} PR: #${pr} (auto-strict: the strict gates run on it, then it's queued). Agents can use the crate from the next run after it merges.`);
    return label(["dependency:pr-open"]);
}

/** Borderline requests without `dependency:approved` 24 h after they were labelled borderline: rejected. */
async function sweep() {
    const hours = Number(opt("--hours") || 24);
    const now = Date.now();
    for (let page = 1; ; page++) {
        const batch = await gh("GET", `/repos/${REPO}/issues?labels=dependency:borderline&state=open&per_page=100&page=${page}`);
        for (const i of batch) {
            if (i.labels.some((l) => l.name === "dependency:approved")) continue;
            const events = await gh("GET", `/repos/${REPO}/issues/${i.number}/events?per_page=100`);
            const at = events.filter((e) => e.event === "labeled" && e.label && e.label.name === "dependency:borderline").map((e) => Date.parse(e.created_at)).pop();
            if (!at || now - at < hours * 3_600_000) continue;
            await gh("POST", `/repos/${REPO}/issues/${i.number}/comments`, { body: `${HEAD} · rejected\n\nNo one approved this borderline request within ${hours} hours. Closing.` });
            await gh("POST", `/repos/${REPO}/issues/${i.number}/labels`, { labels: ["dependency:rejected"] });
            await gh("PATCH", `/repos/${REPO}/issues/${i.number}`, { state: "closed", state_reason: "not_planned" });
            console.log(`#${i.number}: rejected after ${hours} h`);
        }
        if (batch.length < 100) break;
    }
}

module.exports = { lockPackages, checkDecision };

if (require.main === module) {
    const commands = { authorize, check, comment, sweep };
    const cmd = commands[process.argv[2]];
    if (!cmd) {
        console.error(`usage: steward.js ${Object.keys(commands).join("|")} ...`);
        process.exit(2);
    }
    cmd().catch((e) => {
        console.error(e.message);
        process.exitCode = 1;
    });
}
