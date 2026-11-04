"use strict";
// Dependency steward, pure logic (no I/O, no AI). factory policies/dependencies.yaml decides;
// steward.js gathers the facts. See README.md.

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const VERSION = /^\d+(\.\d+){0,2}$/; // a caret requirement, as `cargo add name@<version>` takes it

/** Crate names compare case-insensitively with `-` and `_` the same (as crates.io does). */
const norm = (s) => String(s).toLowerCase().replace(/-/g, "_");

/** The value under a `### Heading` (to the next heading), or null when absent or empty. */
function section(body, heading) {
    const lines = String(body || "").replace(/\r/g, "").split("\n");
    const start = lines.findIndex((l) => l.trim() === `### ${heading}`);
    if (start < 0) return null;
    const out = [];
    for (let i = start + 1; i < lines.length && !lines[i].startsWith("### "); i++) out.push(lines[i]);
    const v = out.join("\n").trim();
    return v === "" || v === "_No response_" ? null : v;
}

const ERRORS = {
    crate: "Crate must be a crates.io crate name",
    version: "Version must be a version such as `1`, `1.2` or `1.2.3` (a caret requirement)",
    kind: "Kind must be `runtime` or `dev`",
    reason: "Reason must say why the crate is needed (1-2000 characters)",
};

/** A dependency request (the agent's issue or the form) → {crate, version, kind, task}, or {error}. */
function parseRequest(body) {
    const crate = section(body, "Crate");
    if (!crate || !NAME.test(crate)) return { error: ERRORS.crate };
    const version = section(body, "Version");
    if (!version || !VERSION.test(version)) return { error: ERRORS.version };
    const kind = section(body, "Kind");
    if (kind !== "runtime" && kind !== "dev") return { error: ERRORS.kind };
    const reason = section(body, "Reason");
    if (!reason || reason.length > 2000) return { error: ERRORS.reason };
    const task = section(body, "Task");
    return { crate, version, kind, task: task && /^[a-z0-9-]+(\/[a-z0-9-]+)+$/.test(task) ? task : null };
}

/** Optimal string alignment distance (Levenshtein plus adjacent swaps). */
function distance(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
        }
    }
    return d[a.length][b.length];
}

/**
 * The popular crate this name is a near miss of, or null. Near miss: not the same crate, and an
 * edit distance of 1 (2 for names of 8+ characters) after normalizing, or the same letters with
 * separators added or removed (`serdejson` vs `serde_json`).
 */
function nearMiss(name, popular) {
    const n = norm(name);
    for (const p of popular) {
        const q = norm(p);
        if (q === n) return null; // it IS the popular crate
    }
    for (const p of popular) {
        const q = norm(p);
        const limit = Math.min(n.length, q.length) >= 8 ? 2 : 1;
        if (distance(n, q) <= limit || n.replace(/_/g, "") === q.replace(/_/g, "")) return p;
    }
    return null;
}

/**
 * Whether an SPDX expression is allowed: evaluated with OR = any, AND = all, parentheses, and
 * `X WITH Y` allowed only if that exact string is on the allowlist. Old `/` means OR. The whole
 * expression on the allowlist (e.g. "MIT OR Apache-2.0") is allowed too. Anything else: false.
 */
function licenceAllowed(expr, allow) {
    if (typeof expr !== "string" || !expr.trim()) return false;
    const e = expr.trim().replace(/\s*\/\s*/g, " OR ");
    if (allow.includes(e)) return true;
    const tokens = e.match(/\(|\)|[^\s()]+/g);
    let i = 0;
    const fail = () => {
        throw new Error("bad SPDX");
    };
    const factor = () => {
        if (tokens[i] === "(") {
            i++;
            const v = or();
            if (tokens[i++] !== ")") fail();
            return v;
        }
        const id = tokens[i++];
        if (!id || ["AND", "OR", "WITH", ")"].includes(id)) fail();
        if (tokens[i] === "WITH") {
            const exc = tokens[i + 1];
            if (!exc) fail();
            i += 2;
            return allow.includes(`${id} WITH ${exc}`);
        }
        return allow.includes(id);
    };
    const and = () => {
        let v = factor();
        while (tokens[i] === "AND") {
            i++;
            v = factor() && v;
        }
        return v;
    };
    const or = () => {
        let v = and();
        while (tokens[i] === "OR") {
            i++;
            v = and() || v;
        }
        return v;
    };
    try {
        const v = or();
        return i === tokens.length && v;
    } catch {
        return false;
    }
}

/**
 * Whether a cargo-vet audits.toml has a full audit of name@version meeting the criteria the kind
 * needs (runtime: safe-to-deploy; dev: safe-to-run or safe-to-deploy). Minimal reader for
 * `[[audits.<name>]]` tables with `criteria` and `version` (deltas and wildcards don't count).
 */
function audited(toml, name, version, kind) {
    const ok = kind === "dev" ? ["safe-to-run", "safe-to-deploy"] : ["safe-to-deploy"];
    const blocks = String(toml).split(/^\[\[/m).slice(1);
    for (const b of blocks) {
        const head = /^audits\.("?)([A-Za-z0-9_-]+)\1\]\]/.exec(b);
        if (!head || norm(head[2]) !== norm(name)) continue;
        const v = /^version\s*=\s*"([^"]+)"/m.exec(b);
        const c = /^criteria\s*=\s*(\[[^\]]*\]|"[^"]*")/m.exec(b);
        if (!v || v[1] !== version || !c) continue;
        const criteria = c[1].match(/"([^"]+)"/g).map((s) => s.slice(1, -1));
        if (criteria.some((x) => ok.includes(x))) return true;
    }
    return false;
}

/**
 * The verdict from the facts steward.js gathered and the policy.
 * facts: {request, resolved: {name, version, licence, yanked}, crate: {created_at, downloads, newest_release_at},
 *         new_packages: [{name, version, licence, build_script_network, native}], changed_locked: [names],
 *         deny: {ok, failures: [codes]}, popular: [names], audited: bool, already: bool, now: Date}
 * @returns {{verdict: "pass"|"borderline"|"fail"|"already", hard: string[], soft: string[], waived: string[]}}
 */
function decide(facts, policy) {
    const { request, resolved, crate, new_packages: pkgs } = facts;
    if (facts.already) return { verdict: "already", hard: [], soft: [], waived: [] };
    const h = policy.hard_checks;
    const s = policy.soft_checks;
    const hard = [];
    const soft = [];
    if (h.denylist.map(norm).includes(norm(request.crate)) || pkgs.some((p) => h.denylist.map(norm).includes(norm(p.name)))) hard.push("denylist");
    if (h.typosquat_check) {
        const miss = nearMiss(request.crate, [...facts.popular, ...Object.values(policy.preapproved || {}).flat(), ...h.denylist]);
        if (miss) hard.push(`typosquat:${miss}`);
    }
    const named = new Map([resolved, ...pkgs].map((p) => [`${p.name}@${p.version}`, p]));
    for (const p of named.values()) if (!licenceAllowed(p.licence, h.licence_allowlist)) hard.push(`licence:${p.name}`);
    if (resolved.yanked) hard.push("yanked");
    for (const code of facts.deny.ok ? [] : facts.deny.failures.length ? facts.deny.failures : ["unknown"]) hard.push(`cargo_deny:${code}`);
    if (h.network_in_build_script === false) for (const p of pkgs) if (p.build_script_network) hard.push(`build_script_network:${p.name}`);

    const day = 86_400_000;
    const age = (facts.now - Date.parse(crate.created_at)) / day;
    if (!(age >= s.min_crate_age_days)) soft.push("min_crate_age_days");
    if (!(crate.downloads >= s.min_downloads)) soft.push("min_downloads");
    if (!((facts.now - Date.parse(crate.newest_release_at)) / day <= s.max_months_since_release * 30.44)) soft.push("max_months_since_release");
    if (pkgs.filter((p) => norm(p.name) !== norm(resolved.name)).length > s.max_new_transitive) soft.push("max_new_transitive");
    // Native code: the requested crate's own (an audit can cover it) and every other new crate's (it can't).
    if (s.native_code === false && pkgs.some((p) => p.native && norm(p.name) === norm(resolved.name))) soft.push("native_code");
    for (const p of pkgs) if (s.native_code === false && p.native && norm(p.name) !== norm(resolved.name)) soft.push(`native_code:${p.name}`);
    if (facts.changed_locked.length > 0) soft.push("changes_locked_versions");

    // Waivers: the owner's preapproved list covers every soft check but a change to locked versions;
    // trusted audits cover the crate's own trust signals; an owner exception waives exactly what it lists.
    const waived = [];
    const own = ["min_crate_age_days", "min_downloads", "max_months_since_release", "native_code"];
    const preapproved = (request.kind === "dev" ? policy.preapproved.dev : [...(policy.preapproved.runtime || []), ...(policy.preapproved.wasm || [])]).map(norm);
    const exception = (policy.exceptions || []).find(
        (x) => norm(x.crate) === norm(request.crate) && (x.kind || "runtime") === request.kind && (resolved.version === String(x.version) || resolved.version.startsWith(`${x.version}.`)),
    );
    for (const c of [...soft]) {
        const why =
            preapproved.includes(norm(request.crate)) && c !== "changes_locked_versions"
                ? "preapproved"
                : facts.audited && own.includes(c)
                  ? "audited"
                  : exception && (exception.waives || []).includes(c)
                    ? "exception"
                    : null;
        if (why) {
            soft.splice(soft.indexOf(c), 1);
            waived.push(`${c}:${why}`);
        }
    }
    return { verdict: hard.length ? "fail" : soft.length ? "borderline" : "pass", hard, soft, waived };
}

/** Network use in a build script: an HTTP client, sockets, or shelling out to a downloader. */
function buildScriptNetwork(source, buildDeps) {
    const clients = ["reqwest", "ureq", "curl", "hyper", "attohttpc", "minreq", "isahc", "surf", "ehttp", "tokio"];
    if (buildDeps.some((d) => clients.includes(norm(d)))) return true;
    // Code, not comments: URLs in doc comments are common and harmless.
    const code = String(source || "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    // git is fine for local queries (rev-parse); fetching commands aren't.
    return /\b(TcpStream|UdpSocket|TcpListener|std::net::|reqwest::|ureq::|curl::|hyper::)|Command::new\(\s*"(curl|wget|nc|fetch)"|"(clone|fetch|pull|ls-remote|submodule)"/.test(code);
}

/** Native code: a `links` key, or a build dependency that compiles or links C/C++. */
const isNative = (links, buildDeps) => Boolean(links) || buildDeps.some((d) => ["cc", "cmake", "bindgen", "pkg_config", "autotools", "vcpkg"].includes(norm(d)));

module.exports = { norm, section, ERRORS, parseRequest, distance, nearMiss, licenceAllowed, audited, decide, buildScriptNetwork, isNative };
