#!/usr/bin/env node
"use strict";
// Scheduled fire drills (factory policies/cadence.yaml `fire_drills`). Plain code, no AI.
//
//   node drills/drills.js run [--only <id>[,<id>]] --out results.json
//
// Each drill plants one fault in a throwaway copy of the inputs, runs the real guardrail code from
// main against it with the pinned live policies, and checks that the guardrail bites. Each also runs
// a control (the same check without the fault) that must pass, so a drill can't pass vacuously.
// Nothing leaves the runner: every drill is a dry run (no GitHub writes, no queue, no labels).
// Prerequisites (drills.yml): `npm ci` in harness/ and the controller, `npm run build:upstream`,
// `cargo build --bin chrono-rs-json`, the pinned policies in $POLICIES_DIR, the audit branch at
// $AUDIT_GIT_DIR (ref $AUDIT_HEAD) and the factory repo at $FACTORY_GIT_DIR (verifier + anchors).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const YAML = require("yaml");
const lib = require("./lib");

const HARNESS = path.resolve(__dirname, "..");
const REPO = path.resolve(HARNESS, "..");
const CONTROLLER = path.join(REPO, ".github/factory/controller");

function sh(cmd, args, opts = {}) {
    const res = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 28, ...opts });
    return { status: res.status, out: `${res.stdout || ""}${res.stderr || ""}` };
}

function git(...args) {
    const r = sh("git", ["-C", REPO, ...args]);
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.out.slice(0, 300)}`);
    return r.out.trim();
}

const env = (name) => {
    const v = process.env[name];
    if (!v) throw new Error(`${name} is not set`);
    return v;
};

/** Restores a file after a drill changed it, whatever happens. */
function withFile(file, mutate, body) {
    const original = fs.readFileSync(file, "utf8");
    try {
        fs.writeFileSync(file, mutate(original));
        return body();
    } finally {
        fs.writeFileSync(file, original);
    }
}

const cargoGolden = (areas) =>
    sh("cargo", ["test", "--locked", "--quiet", "--test", "golden", "--", "--nocapture"], { cwd: REPO, env: { ...process.env, GOLDEN_AREAS: areas } });

const DRILLS = {
    /** A planted wrong expectation in a checked golden case fails the golden suite (exactly one case). */
    "golden-mismatch": () => {
        const area = "en/weekday";
        const file = path.join(REPO, "tests/golden", `${area}.json`);
        const control = cargoGolden(area);
        if (control.status !== 0) return lib.fail("control: the golden suite fails on main's data", control.out);
        return withFile(file, lib.plantGoldenMismatch, () => {
            const r = cargoGolden(area);
            return r.status !== 0 && /\b1 golden case\(s\) failed/.test(r.out)
                ? lib.pass("the planted expectation failed exactly one golden case")
                : lib.fail("the golden suite didn't catch the planted expectation", r.out);
        });
    },

    /** A planted mismatch in the comparison with chrono-node is reported (exactly one). */
    "comparison-mismatch": () => {
        const rust = path.join(REPO, "target/debug/chrono-rs-json");
        const seed = lib.seedFor(new Date());
        const args = ["compare/compare.js", "--seed", String(seed), "--phrases", "300", "--rust", rust];
        const control = sh(process.execPath, args, { cwd: HARNESS });
        if (control.status !== 0) return lib.fail(`control: seed ${seed} mismatches without a plant`, control.out);
        const r = sh(process.execPath, [...args, "--plant"], { cwd: HARNESS });
        const summary = lib.compareSummary(r.out);
        return r.status === 1 && summary && summary.mismatched === 1
            ? lib.pass(`seed ${seed}: the planted mismatch was the one reported`)
            : lib.fail(`seed ${seed}: the planted mismatch wasn't reported as exactly one`, r.out);
    },

    /** The scope gate rejects an agent PR touching a path outside its contract, a protected path, or a stale contract. */
    "scope-reject": () => {
        const scope = require("../gates/scope");
        const tiers = YAML.parse(fs.readFileSync(path.join(env("POLICIES_DIR"), "tiers.yaml"), "utf8"));
        const loadContract = (id) => {
            const f = path.join(REPO, "contracts", `${id}.yaml`);
            if (!fs.existsSync(f)) return null;
            return { ...YAML.parse(fs.readFileSync(f, "utf8")), lastCommit: git("log", "-1", "--format=%H", "HEAD", "--", `contracts/${id}.yaml`) };
        };
        const task = lib.pickContract(fs.readdirSync(path.join(REPO, "contracts/en")).map((f) => `en/${f.replace(/\.yaml$/, "")}`), loadContract);
        const contract = loadContract(task);
        const results = lib.scopeCases({ task, contract }).map((c) => ({
            ...c,
            got: scope.evaluate({ isAgent: true, body: c.body, changed: c.changed, protectedGlobs: tiers.protected_from_agents, loadContract, readFile: () => "" }),
        }));
        const bad = results.filter((c) => c.got.ok !== c.ok || !c.reasons.every((re) => c.got.reasons.some((x) => re.test(x))));
        return bad.length === 0
            ? lib.pass(`${task}: in-scope change passes; out-of-scope, protected and stale-contract changes are rejected`)
            : lib.fail("the scope gate didn't decide as expected", JSON.stringify(bad.map((c) => ({ case: c.name, got: c.got })), null, 2));
    },

    /** With the kill switch off, the controller dispatches nothing (control: with it on, it would). */
    "kill-switch": () => {
        const on = lib.controllerReasons(runController({ FACTORY_ENABLED: "true" }));
        if (!on.would_dispatch) return lib.fail("control: the fixture dispatches nothing even with FACTORY_ENABLED=true", JSON.stringify(on));
        // Unset, empty, and near-misses: only the exact string "true" enables dispatch.
        const offs = [undefined, "", "TRUE", "1"].map((v) => [v === undefined ? "unset" : JSON.stringify(v), lib.controllerReasons(runController({ FACTORY_ENABLED: v }))]);
        const leaked = offs.filter(([, r]) => r.would_dispatch || !r.kill_switch).map(([name]) => name);
        return leaked.length === 0
            ? lib.pass(`kill switch off (unset, "", "TRUE", "1"): 0 dispatches, held by kill_switch (on: ${on.would_dispatch} would dispatch)`)
            : lib.fail(`the kill switch didn't stop dispatch with FACTORY_ENABLED ${leaked.join(", ")}`, JSON.stringify(offs));
    },

    /** Spend at the daily cap pauses dispatch; past the alert threshold alerts the owner (live budgets). */
    "over-cap": () => {
        const budgets = YAML.parse(fs.readFileSync(path.join(env("POLICIES_DIR"), "budgets.yaml"), "utf8"));
        const max = budgets.factory_per_day.max_aic;
        const alertAt = Math.ceil((max * budgets.factory_per_day.alert_at_pct) / 100);
        const at = (aic) => lib.controllerReasons(runController({ FACTORY_ENABLED: "true" }, (s) => ({ ...s, factory_aic_today: aic })));
        const zero = at(0);
        const alert = at(alertAt);
        const over = at(max);
        const ok = zero.would_dispatch > 0 && !zero.budget_pause && alert.budget_alert > 0 && !alert.budget_pause && over.budget_pause > 0 && !over.would_dispatch;
        return ok
            ? lib.pass(`0 AIC: dispatch; ${alertAt} AIC (${budgets.factory_per_day.alert_at_pct}%): alert; ${max} AIC: paused, 0 dispatches`)
            : lib.fail("the daily cap didn't hold", JSON.stringify({ zero, alert, over }));
    },

    /** Onboarding's stop rules fail closed: lagging or unreadable inputs never onboard (control: complete data does). */
    "onboard-stop-rules": () => {
        const policy = YAML.parse(fs.readFileSync(path.join(env("POLICIES_DIR"), "onboarding.yaml"), "utf8"));
        const code = require("../lib/locales").generatedLocales(REPO)[0]?.code;
        if (!code) return lib.fail("control: no generated locale on main to drill with");
        // The live stop rules, with every upstream locale not onboarded yet as the language list: the
        // control must be able to onboard even after the owner's list is done (then: no candidate, skip it).
        const candidates = sh(process.execPath, ["onboard/onboard.js", "candidates"], { cwd: HARNESS }).out.split("\n").filter((c) => /^[a-z]{2}(-[a-z]{4})?$/.test(c));
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drill-onboard-"));
        fs.writeFileSync(path.join(dir, "policy.yaml"), YAML.stringify({ ...policy, languages: candidates.length ? candidates : policy.languages }));
        // Every generated contract on main, each with a (closed) task issue in the control.
        const contracts = require("../lib/locales")
            .generatedLocales(REPO)
            .flatMap((l) => (fs.existsSync(path.join(REPO, "contracts", l.code)) ? fs.readdirSync(path.join(REPO, "contracts", l.code)).filter((f) => f.endsWith(".yaml") && !f.startsWith("fix-")).map((f) => `${l.code}/${f.slice(0, -5)}`) : []));
        const cases = lib.onboardCases(policy, code, contracts).filter((c) => !c.ok || candidates.length > 0);
        const results = cases.map((c) => {
            for (const [f, text] of Object.entries(c.files)) fs.writeFileSync(path.join(dir, `${f}.json`), text);
            const args = ["policy.yaml", ...Object.keys(c.files).map((f) => `${f}.json`)].flatMap((f) => [`--${f.split(".")[0]}`, path.join(dir, f)]);
            const r = sh(process.execPath, ["onboard/onboard.js", "next", ...args], { cwd: HARNESS });
            let got = null;
            try {
                got = JSON.parse(r.out.trim().split("\n").pop());
            } catch {}
            return { ...c, files: undefined, got };
        });
        fs.rmSync(dir, { recursive: true, force: true });
        const bad = results.filter((c) => !c.got || (c.got.action === "onboard") !== c.ok);
        return bad.length === 0
            ? lib.pass(`${code}: ${candidates.length ? "complete data onboards" : "control skipped (no candidate left)"}; ${results.filter((c) => !c.ok).length} lagging, unreadable or over-budget inputs don't (${results.filter((c) => !c.ok).map((c) => c.got.reason).join(", ")})`)
            : lib.fail("the onboarding decision didn't fail closed", JSON.stringify(bad, null, 2));
    },

    /** hints.yaml still holds against the pinned chrono-node; broken copies fail (a reachable step declared unreachable, a wrong shadow, a dead seed). */
    "onboard-hints": () => {
        const hintsFile = path.join(HARNESS, "onboard/hints.yaml");
        const real = YAML.parse(fs.readFileSync(hintsFile, "utf8"));
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drill-hints-"));
        const check = (h) => {
            const f = path.join(dir, "hints.yaml");
            fs.writeFileSync(f, YAML.stringify(h));
            const r = sh(process.execPath, ["onboard/onboard.js", "hints-check", "--hints", f], { cwd: HARNESS });
            try {
                return JSON.parse(r.out.trim().split("\n").pop());
            } catch {
                return { ok: false, problems: [`no result: ${r.out.slice(-300)}`] };
            }
        };
        const control = check(real);
        const broken = [];
        const seeded = Object.entries(real.seeds || {})[0];
        if (seeded) {
            const [step, seeds] = seeded;
            const cfg = seeds[0].config;
            broken.push([`${step} declared unreachable (its seed reaches it)`, { unreachable: { [step]: { reason: "drill", probe: { configs: [cfg], options: [{}], words: [seeds[0].text] } } } }]);
            broken.push([`a seed for ${step} that reaches nothing`, { seeds: { [step]: [{ ...seeds[0], text: "nothing here" }] } }]);
        }
        const shadowed = Object.entries(real.unreachable || {}).find(([, e]) => e.shadowed_by);
        if (shadowed) {
            const [step, e] = shadowed;
            broken.push([`${step} shadowed by a refiner that runs after it`, { unreachable: { [step]: { ...e, shadowed_by: "OverlapRemovalRefiner", probe: { ...e.probe, configs: e.probe.configs.slice(0, 1) } } } }]);
        }
        const missed = broken.filter(([, h]) => check(h).ok).map(([name]) => name);
        fs.rmSync(dir, { recursive: true, force: true });
        if (!control.ok) return lib.fail("control: hints.yaml doesn't hold against the pinned chrono-node", control.problems.join("\n"));
        return missed.length === 0 && broken.length > 0
            ? lib.pass(`${control.checked} hints hold; ${broken.length} broken copies fail`)
            : lib.fail(`the hints check accepted: ${missed.join(", ") || "(no broken copies built)"}`);
    },

    /** The independent audit verifier fails on a tampered copy of the real audit log (control: the real log passes). */
    "audit-tamper": async () => {
        const verifier = await import(path.join(env("FACTORY_GIT_DIR"), "verifier/verify.mjs"));
        const head = env("AUDIT_HEAD");
        const files = verifier.readBlobs(env("AUDIT_GIT_DIR"), head);
        const anchors = () => verifier.readAnchorVersions(env("FACTORY_GIT_DIR"), "origin/anchors");
        const at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
        const check = (auditFiles) => verifier.run({ auditFiles, auditHead: head, anchorVersions: anchors(), bootstrap: false, at, runId: Number(process.env.GITHUB_RUN_ID) || 1 });
        const control = check(files);
        if (!control.ok) return lib.fail("control: the real audit log doesn't verify", control.errors.join("\n"));
        const tampered = [
            ["one payload byte changed", lib.tamperPayload(files)],
            ["the log truncated to half its events", lib.truncateHalf(files)],
        ];
        const missed = tampered.filter(([, f]) => check(f).ok).map(([name]) => name);
        return missed.length === 0
            ? lib.pass(`${control.events} events verify; both tampered copies fail`)
            : lib.fail(`the verifier accepted: ${missed.join(", ")}`);
    },
};

function runController(environment, edit = (s) => s) {
    const snapshot = JSON.parse(fs.readFileSync(path.join(CONTROLLER, "test/fixtures/snapshot.json"), "utf8"));
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "drill-")), "snapshot.json");
    fs.writeFileSync(file, JSON.stringify(edit(snapshot)));
    // An undefined value removes the variable (not an empty string): the unset case is its own drill.
    const childEnv = { ...process.env, ...environment, GH_TOKEN: "", GITHUB_TOKEN: "" };
    for (const [k, v] of Object.entries(childEnv)) if (v === undefined) delete childEnv[k];
    const r = sh(process.execPath, ["main.ts", "--fixture", file, "--print", "--policies", env("POLICIES_DIR")], { cwd: CONTROLLER, env: childEnv });
    if (r.status !== 0) throw new Error(`controller fixture run failed: ${r.out.slice(-500)}`);
    return r.out;
}

async function main() {
    const [cmd] = process.argv.slice(2);
    const opt = (n) => {
        const i = process.argv.indexOf(n);
        return i > 0 ? process.argv[i + 1] : null;
    };
    if (cmd !== "run" || !opt("--out")) {
        console.error(`usage: drills.js run [--only ${Object.keys(DRILLS).join(",")}] --out FILE`);
        process.exit(2);
    }
    const only = opt("--only") ? opt("--only").split(",") : Object.keys(DRILLS);
    const unknown = only.filter((id) => !DRILLS[id]);
    if (unknown.length) throw new Error(`unknown drill ${unknown.join(", ")}`);
    const results = [];
    for (const id of only) {
        const started = Date.now();
        let r;
        try {
            r = await DRILLS[id]();
        } catch (e) {
            r = lib.fail(`error: ${e.message}`);
        }
        results.push({ id, ...r, seconds: Math.round((Date.now() - started) / 1000) });
        console.log(`${r.result === "pass" ? "PASS" : "FAIL"} ${id}: ${r.summary}`);
        if (r.result !== "pass" && r.detail) console.log(r.detail.slice(-4000));
    }
    fs.writeFileSync(opt("--out"), JSON.stringify({ at: new Date().toISOString(), main: git("rev-parse", "HEAD"), results }, null, 2) + "\n");
    process.exitCode = results.every((r) => r.result === "pass") ? 0 : 1;
}

main().catch((e) => {
    console.error(e.message);
    process.exit(1);
});
