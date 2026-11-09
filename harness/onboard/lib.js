"use strict";
// Pure logic of the onboarding generator (onboard.js does the I/O). Deterministic: the same
// upstream/, golden data and task map always render the same bytes.
const fs = require("fs");
const path = require("path");
const YAML = require("yaml");

const GENERATOR = "harness/onboard/onboard.js";
const EXPORTS = ["casual", "strict"];
const MAX_CALL_CASES = 8;

/** `fi` -> {code: fi, module: fi, ...}; `zh-hans` -> module zh_hans, upstream locales/zh/hans. */
function manifestFor(code, exportedNames) {
    if (!/^[a-z]{2}(?:-[a-z]{4})?$/.test(code)) throw new Error(`bad locale code ${code}`);
    const configs = {};
    for (const e of EXPORTS) if (exportedNames.includes(e)) configs[`${code.replace("-", ".")}.${e}`] = e;
    if (Object.keys(configs).length === 0) throw new Error(`locales/${code}: exports neither casual nor strict`);
    return {
        generator: GENERATOR,
        code,
        module: code.replace("-", "_"),
        upstream: `locales/${code.replace("-", "/")}`,
        tests: `test/${code.replace("-", "/")}`,
        configs,
    };
}

function renderManifest(m) {
    const ordered = { generator: m.generator, code: m.code, module: m.module, upstream: m.upstream, tests: m.tests, configs: m.configs };
    return JSON.stringify(ordered, null, 2) + "\n";
}

/** `TimeUnitWithinFormat` -> `time_unit_within_format`. */
function snake(name) {
    if (/^[A-Z0-9_]+$/.test(name)) return name.toLowerCase();
    return name
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
        .toLowerCase();
}
const kebab = (name) => snake(name).replace(/_/g, "-");

/** `FICasualDateParser` -> `CasualDateParser`; `ZHHansDateParser` -> `DateParser`. */
function withoutLocalePrefix(step) {
    const m = /^[A-Z]{2}(?:Hans|Hant)?(?=[A-Z][a-z])/.exec(step);
    return m ? step.slice(m[0].length) : step;
}

/** Step file name -> Rust file stem, as the hand-mapped tasks do (`casual_date`, `merge_date_range`). */
function rustStem(step) {
    return snake(withoutLocalePrefix(step).replace(/(Parser|Refiner)$/, ""));
}

/** Area by what the step does, so related steps serialize (the area lock). */
function areaBucket(step, kind) {
    if (kind === "refiners") return "refiners";
    const s = withoutLocalePrefix(step);
    if (/^Casual/.test(s)) return "casual";
    if (/TimeUnit|Relative|Ago|Later|Within|Deadline/.test(s)) return "relative";
    if (/Time(Expression)?Parser$|SpecificTime/.test(s)) return "time";
    return "dates";
}

/**
 * The locale's upstream files: `steps` (parsers/, refiners/; not abstract bases) and `support`
 * (constants.ts and abstract bases), each {source: relative to upstream/src, name, kind, text}.
 */
function listLocaleFiles(upstreamSrc, upstream) {
    const steps = [];
    const support = [];
    const dir = path.join(upstreamSrc, upstream);
    for (const f of fs.readdirSync(dir).sort()) {
        if (f === "constants.ts") support.push({ source: `${upstream}/${f}`, name: "constants", kind: "constants", text: fs.readFileSync(path.join(dir, f), "utf8") });
    }
    for (const kind of ["parsers", "refiners"]) {
        const d = path.join(dir, kind);
        if (!fs.existsSync(d)) continue;
        for (const f of fs.readdirSync(d).sort()) {
            if (!f.endsWith(".ts")) continue;
            const text = fs.readFileSync(path.join(d, f), "utf8");
            const name = f.slice(0, -3);
            if (/^Abstract/.test(name) || !/export\s+default\s+class\s/.test(text)) {
                support.push({ source: `${upstream}/${kind}/${f}`, name, kind: "base", text });
            } else steps.push({ source: `${upstream}/${kind}/${f}`, name, kind, text });
        }
    }
    return { steps, support };
}

/** Which support files a source imports (`../constants`, `./AbstractParserWithWordBoundaryChecking`). */
function importsOf(file, support) {
    const out = [];
    for (const m of file.text.matchAll(/from\s+["']([^"']+)["']/g)) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file.source), m[1]));
        const s = support.find((x) => x.source.replace(/\.ts$/, "") === target);
        if (s && s !== file) out.push(s);
    }
    return out;
}

function supportId(code, s) {
    return `${code}/${kebab(s.name)}`;
}

function supportRust(manifest, s) {
    return `src/locales/${manifest.module}/${snake(s.name)}.rs`;
}

/**
 * The task map fragment (scripts/seed-backlog/taskmap.d/<module>.yaml): one task per step of the
 * locale's configurations that isn't done or mapped yet, one support task per shared file.
 */
function taskmapFragment({ manifest, configs, baseTaskmap, localeFiles, constants, goldenTexts }) {
    const known = new Set([...(baseTaskmap.done || []).map((d) => d.step), ...(baseTaskmap.tasks || []).map((t) => t.step)]);
    const needed = [];
    for (const cfg of Object.values(configs)) {
        for (const s of [...cfg.parsers, ...cfg.refiners]) if (!known.has(s.name) && !needed.includes(s.name)) needed.push(s.name);
    }
    const problems = [];
    const tasks = [];
    const usedSupport = new Set();
    const stepTasks = [];
    for (const step of needed) {
        const file = localeFiles.steps.find((f) => f.name === step);
        if (!file) {
            problems.push(`step ${step} is neither a file of ${manifest.upstream} nor in the task map: a hand decision`);
            continue;
        }
        const declared = (/export\s+default\s+class\s+(\w+)/.exec(file.text) || [])[1];
        const needs = importsOf(file, localeFiles.support);
        needs.forEach((s) => usedSupport.add(s));
        // A step that imports another step (FICasualDateParser uses FICasualTimeParser's helper)
        // needs that step's file first: its own scope is one file.
        const stepNeeds = importsOf(file, localeFiles.steps).map((s) => `${manifest.code}/${kebab(withoutLocalePrefix(s.name))}`);
        stepTasks.push({
            id: `${manifest.code}/${kebab(withoutLocalePrefix(step))}`,
            locale: manifest.module,
            step,
            ...(declared && declared !== step ? { class: declared } : {}),
            source: file.source,
            rust: `src/locales/${manifest.module}/${file.kind}/${rustStem(step)}.rs`,
            area: `${manifest.code}-${areaBucket(step, file.kind)}`,
            ...(needs.length || stepNeeds.length ? { needs: [...needs.map((s) => supportId(manifest.code, s)), ...stepNeeds].sort() } : {}),
        });
    }
    // A step may only need steps that are tasks here (an imported step outside the configurations can't be ported first).
    const ids = new Set(stepTasks.map((t) => t.id));
    const supportIds = new Set(localeFiles.support.map((s) => supportId(manifest.code, s)));
    for (const t of stepTasks) {
        for (const n of t.needs || []) if (!ids.has(n) && !supportIds.has(n)) problems.push(`${t.id} imports ${n}, which is no task here: a hand decision`);
    }
    if (problems.length > 0) throw new Error(`cannot onboard ${manifest.code}:\n  ${problems.join("\n  ")}`);
    // Support files the steps use, and what those use in turn.
    const queue = [...usedSupport];
    while (queue.length) for (const s of importsOf(queue.shift(), localeFiles.support)) if (!usedSupport.has(s)) usedSupport.add(s) && queue.push(s);
    for (const s of localeFiles.support.filter((x) => usedSupport.has(x))) {
        const needs = importsOf(s, localeFiles.support).map((x) => supportId(manifest.code, x)).sort();
        const t = {
            id: supportId(manifest.code, s),
            locale: manifest.module,
            kind: "support",
            source: s.source,
            rust: supportRust(manifest, s),
            area: `${manifest.code}-support`,
            ...(needs.length ? { needs } : {}),
        };
        if (s.kind === "constants" && constants) t.unit = constantsUnit(manifest, constants, goldenTexts);
        else t.requirement = baseRequirement(manifest, s, stepTasks.filter((x) => (x.needs || []).includes(t.id)).map((x) => x.id));
        tasks.push(t);
    }
    const rusts = new Set();
    for (const t of [...tasks, ...stepTasks]) {
        if (rusts.has(t.rust)) throw new Error(`cannot onboard ${manifest.code}: two tasks would write ${t.rust}`);
        rusts.add(t.rust);
    }
    tasks.push(...stepTasks);
    tasks.sort((a, b) => (a.id < b.id ? -1 : 1));
    return { version: 1, locale: manifest.module, generated_by: GENERATOR, tasks };
}

function baseRequirement(manifest, s, dependents) {
    return (
        `Port upstream \`${s.source}\` (shared by this locale's steps) into this one file, keeping upstream's structure ` +
        `(PORTING.md: a shared base becomes a trait or helper the steps use). It has no golden case of its own: ` +
        `${dependents.length ? `the steps that use it (${dependents.join(", ")}) depend on this task, and their golden cases check it.` : "nothing checks it directly."}`
    );
}

/** JSON-able result, with NaN/undefined as null (Rust: None). */
function encode(v) {
    if (v === undefined || (typeof v === "number" && Number.isNaN(v))) return null;
    if (v === null || typeof v === "string" || typeof v === "boolean" || typeof v === "number") return v;
    if (Array.isArray(v)) return v.map(encode);
    if (typeof v === "object") {
        const out = {};
        for (const [k, x] of Object.entries(v)) out[k] = encode(x);
        return out;
    }
    throw new Error(`unsupported value ${typeof v}`);
}

const isPlainMap = (v) =>
    v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype &&
    Object.values(v).every((x) => ["string", "number", "boolean"].includes(typeof x));

/**
 * Unit cases for a locale's constants.ts, recorded from the compiled upstream module: every
 * exported string pattern and dictionary exactly, and each one-argument exported function on up to
 * MAX_CALL_CASES inputs (taken from the dictionaries' keys, the patterns' matches in the locale's
 * golden texts and a few numerals) that give distinct results.
 */
function constantsUnit(manifest, constants, goldenTexts) {
    const order = [...constants.source.matchAll(/^export\s+(?:const|function|let|var)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
    const mod = constants.module;
    const cases = [];
    const unchecked = [];
    const maps = order.filter((n) => isPlainMap(mod[n]));
    const patterns = order.filter((n) => typeof mod[n] === "string");
    // Inputs in order of preference: what the locale's golden texts really contain, then the
    // dictionaries' words, then plain numerals; each sorted, so the choice is stable.
    const byText = (a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
    const matched = new Set();
    for (const n of patterns) {
        let re;
        try {
            re = new RegExp(mod[n], "gi");
        } catch {
            continue;
        }
        for (const t of goldenTexts) for (const m of t.matchAll(re)) if (m[0].trim()) matched.add(m[0]);
    }
    const words = new Set(maps.flatMap((n) => Object.keys(mod[n])));
    // Round-robin over the three sources, so words aren't crowded out by numerals.
    const sources = [[...matched].sort(byText), [...words].sort(byText), ["1", "2", "7", "12", "15", "31", "42", "99", "2024"]];
    const candidates = [];
    for (let i = 0; sources.some((l) => i < l.length); i++) for (const l of sources) if (i < l.length && !candidates.includes(l[i])) candidates.push(l[i]);
    // A result counts as new per kind of input (digits, words, both), so "2" and "kaksi" both stay.
    const inputKind = (x) => (/^\s*\d+\s*$/.test(x) ? "digits" : /\d/.test(x) ? "mixed" : "words");
    for (const n of order) {
        const v = mod[n];
        const t = snake(n);
        if (typeof v === "string") cases.push({ test: `${t}_matches_upstream`, kind: "string", export: n, expect: v });
        else if (v instanceof RegExp) cases.push({ test: `${t}_matches_upstream`, kind: "regex", export: n, expect: { source: v.source, flags: v.flags } });
        else if (isPlainMap(v)) cases.push({ test: `${t}_matches_upstream`, kind: "map", export: n, expect: encode(v) });
        else if (typeof v === "function" && v.length === 1 && !/\bDate\b/.test(v.toString())) {
            const seen = new Map();
            let nulls = 0;
            for (const input of candidates) {
                let out;
                try {
                    out = encode(v(input));
                } catch {
                    continue;
                }
                const empty = out === null || (typeof out === "object" && !Array.isArray(out) && Object.keys(out).length === 0);
                const kind = inputKind(input);
                const key = `${kind}:${JSON.stringify(out)}`;
                if (seen.has(key) || (empty && nulls >= 1)) continue;
                if ([...seen.keys()].filter((k) => k.startsWith(`${kind}:`)).length >= Math.ceil(MAX_CALL_CASES / 3)) continue;
                if (empty) nulls++;
                seen.set(key, { input, out });
                if (seen.size >= MAX_CALL_CASES) break;
            }
            let i = 0;
            for (const { input, out } of seen.values()) cases.push({ test: `${t}_case_${++i}`, kind: "call", export: n, input, expect: out });
            if (seen.size === 0) unchecked.push(n);
        } else unchecked.push(n);
    }
    return {
        requirement:
            `Port upstream \`${manifest.upstream}/constants.ts\` in full into this one file (PORTING.md lessons: every export, ` +
            `dictionary keys byte for byte, patterns built the same way). Name constants in SCREAMING_SNAKE_CASE and functions ` +
            `in snake_case, typed as in \`src/locales/sv/constants.rs\` (NaN or undefined becomes \`None\`). Add one in-file ` +
            `\`#[cfg(test)]\` test per case, named the case's \`test\` (CI checks the names); the cases were recorded from the ` +
            `pinned chrono-node: \`string\`: the constant (a \`&str\` or \`LazyLock<String>\`) equals \`expect\` exactly; ` +
            `\`regex\`: same source and flags; \`map\`: the dictionary has exactly these entries; \`call\`: the function on ` +
            `\`input\` returns \`expect\` (\`null\` = \`None\`; an object compares key by key).` +
            (unchecked.length ? ` Not unit-checked (no recordable value), still ported: ${unchecked.join(", ")}.` : ""),
        cases,
    };
}

function renderFragment(fragment) {
    const header = [
        `# Generated by ${GENERATOR} from upstream/ and tests/golden/. Do not edit: the onboarding PR is`,
        "# regenerated byte for byte in CI. A judgement call (an area, a dependency) belongs in taskmap.yaml.",
        "",
    ].join("\n");
    return header + YAML.stringify(fragment, { lineWidth: 0, flowCollectionPadding: false });
}

const LANGUAGE_NAMES = {
    ar: "Arabic", fi: "Finnish", id: "Indonesian", it: "Italian", nl: "Dutch", ru: "Russian", uk: "Ukrainian", vi: "Vietnamese",
    "zh-hans": "Chinese (Simplified)", "zh-hant": "Chinese (Traditional)",
};

function renderModRs(m) {
    const name = LANGUAGE_NAMES[m.code] || m.code;
    const fns = Object.entries(m.configs).map(([cfg, e]) => ({ cfg, e, up: e.toUpperCase() }));
    const lines = [
        `//! ${name} (upstream \`src/${m.upstream}/\`), generated by \`${GENERATOR}\`. Do not edit.`,
        "//!",
        "//! `parsers/` and `refiners/` are auto-registered, and every other `.rs` file in this directory",
        "//! (`constants.rs`, a shared base) is declared by `build.rs`: a task adds one file and edits no shared line.",
        "",
        "use std::sync::LazyLock;",
        "",
        "use crate::core::chrono::Chrono;",
        "use crate::locales::NamedConfiguration;",
        "",
        "pub mod configuration;",
        "",
        `include!(concat!(env!("OUT_DIR"), "/registry/${m.module}_support.rs"));`,
        "",
        "pub mod parsers {",
        `    //! Auto-registered ${name} parsers.`,
        `    include!(concat!(env!("OUT_DIR"), "/registry/${m.module}_parsers.rs"));`,
        "}",
        "",
        "pub mod refiners {",
        `    //! Auto-registered ${name} refiners.`,
        `    include!(concat!(env!("OUT_DIR"), "/registry/${m.module}_refiners.rs"));`,
        "}",
        "",
    ];
    for (const f of fns) lines.push(`static ${f.up}: LazyLock<Chrono> = LazyLock::new(|| configuration::${f.e}().build());`);
    for (const f of fns) {
        lines.push("", `/// \`chrono.${m.code.replace("-", ".")}.${f.e}\` (\`${f.cfg}\`).`, `pub fn ${f.e}() -> &'static Chrono {`, `    &${f.up}`, "}");
    }
    lines.push("", "/// This locale's named configurations (`crate::configuration`).", "pub const NAMED: &[NamedConfiguration] = &[");
    for (const f of fns) {
        lines.push("    NamedConfiguration {", `        name: "${f.cfg}",`, `        chrono: ${f.e},`, `        configuration: configuration::${f.e},`, "    },");
    }
    lines.push("];", "");
    return lines.join("\n");
}

const KEEP = ".gitkeep";

/**
 * The module skeleton: one empty `.gitkeep` per directory under src/locales/<module>/ that a task's
 * scope file goes in (always `parsers/` and `refiners/`, which build.rs auto-registers), so no
 * agent ever needs mkdir. Fails closed on a scope file outside the locale's module.
 * Returns Map<repo-relative path, "">, sorted.
 */
function moduleSkeleton(manifest, fragment) {
    const root = `src/locales/${manifest.module}`;
    const dirs = new Set([`${root}/parsers`, `${root}/refiners`]);
    for (const t of fragment.tasks) {
        if (!t.rust.startsWith(`${root}/`) || t.rust.split("/").includes("..")) throw new Error(`cannot onboard ${manifest.code}: ${t.id} would write ${t.rust}, outside ${root}/`);
        for (let d = path.posix.dirname(t.rust); d !== root; d = path.posix.dirname(d)) dirs.add(d);
    }
    return new Map([...dirs].sort().map((d) => [`${d}/${KEEP}`, ""]));
}

/** Scope files (repo-relative) whose parent directory isn't in `exists`: what an agent would have to mkdir. */
function missingScopeParents(scopes, exists) {
    return scopes.filter((s) => !exists(path.posix.dirname(s))).sort();
}

/**
 * Problems in onboard.yml's hand-off of the generated files (its text, parsed): the generate job's
 * artifact must keep hidden files (actions/upload-artifact drops them by default) whenever the
 * generator writes one, or apply's file-list check fails on every live onboarding.
 */
function workflowProblems(workflow, generatedPaths) {
    const hidden = generatedPaths.filter((p) => p.split("/").some((part) => part.startsWith(".")));
    if (hidden.length === 0) return [];
    const uploads = Object.values(workflow.jobs || {})
        .flatMap((j) => j.steps || [])
        .filter((st) => String(st.uses || "").startsWith("actions/upload-artifact@") && st.with && st.with.name === "onboard");
    if (uploads.length !== 1) return [`expected one upload of the "onboard" artifact, found ${uploads.length}`];
    return uploads[0].with["include-hidden-files"] === true ? [] : [`the "onboard" artifact drops hidden files (${hidden[0]}, ...): set include-hidden-files: true`];
}

function slotLine(method, s) {
    const flags = Object.entries(s.flags || {});
    const arg = flags.length ? `Flags::of(&[${flags.map(([k, v]) => `("${k}", ${v})`).join(", ")}])` : "Flags::none()";
    const one = `    c.${method}("${s.name}", ${arg});`;
    if (one.length <= 120) return [one];
    return [`    c.${method}(`, `        "${s.name}",`, `        ${arg},`, "    );"];
}

function renderConfigurationRs(m, configs) {
    const lines = [
        `//! upstream \`src/${m.upstream}/index.ts\`: the named configurations' slots, in upstream order with`,
        `//! their constructor flags. Generated by \`${GENERATOR}\` from \`tests/golden/configurations.json\`; do not`,
        "//! edit. The `configurations` test checks them against chrono-node.",
        "",
        "use crate::core::configuration::{Configuration, Flags};",
    ];
    for (const [cfg, e] of Object.entries(m.configs)) {
        const c = configs[cfg];
        lines.push("", `/// \`${cfg}\`: upstream's exported \`${e}\`.`, `pub fn ${e}() -> Configuration {`, "    let mut c = Configuration::default();");
        for (const s of c.parsers) lines.push(...slotLine("push_parser", s));
        for (const s of c.refiners) lines.push(...slotLine("push_refiner", s));
        lines.push("    c", "}");
    }
    lines.push("");
    return lines.join("\n");
}

module.exports = {
    GENERATOR,
    manifestFor,
    renderManifest,
    snake,
    kebab,
    withoutLocalePrefix,
    rustStem,
    areaBucket,
    listLocaleFiles,
    importsOf,
    taskmapFragment,
    constantsUnit,
    renderFragment,
    renderModRs,
    renderConfigurationRs,
    moduleSkeleton,
    missingScopeParents,
    workflowProblems,
};

/** How long a merged onboarding PR's locale may have no task issue for one of its contracts (the
 * push-triggered issues jobs normally take minutes) before the decision stops and alerts. */
const TASK_ISSUES_GRACE_HOURS = 2;

/**
 * Which language to onboard next, or why not. Pure.
 *   policy:     factory policies/onboarding.yaml at the pinned version, or null. Its
 *               `external_locales` (vi) are never onboarded here and left out of everything below
 *               (in flight, contracts without issues, spend, first try, needs-human)
 *   onboarded:  codes of the generated locales on main
 *   candidates: upstream codes not onboarded yet
 *   issues:     factory:task issues of every state [{id, state, labels}] (id from the marker; a missing
 *               state counts as open), or null if unreadable
 *   openPRs:    open onboarding PRs (branch factory/onboard/<code>) [code], or null if unreadable
 *   contracts:  generated locales' task contract ids on main (fix contracts excluded), or null
 *   onboardMerges: merged onboarding PRs [{code, merged_at}], or null if unreadable
 *   ledger:     what actually ran and merged, from the Actions API and GraphQL: {runs: [{run_id,
 *               workflow, title, conclusion, created_at}] completed agent runs, merged: [{task, number,
 *               created_at, zero_touch}] merged agent PRs}, or null if unreadable
 *   costs:      each run's cost from the controller's audit log (runCosts), or null if unreadable
 *   incidents:  infra-incident records from the audit log [{task, labeled_at}] (human_action
 *               infra_incident: a person labeled the task factory:infra-incident with a reference).
 *               For the first-try rate only, a task's implement attempts started before its record,
 *               other than the one whose PR merged, are not counted: the factory failed, not the
 *               agent. Spend still counts them.
 *   now:        ISO time (the task-issue grace period)
 * Returns {action: "onboard", code} | {action: "wait" | "stop", reason}.
 *
 * Fails closed. Spend: every agent run the ledger lists for a generated locale's task (and every
 * review run since the first of those: a review names no task) needs a cost in the audit log, or
 * the decision waits (#317 onboarded id on 0 AIC because the data lagged). First try: every merged
 * task's zero-touch verdict must be known. In flight: a language counts while it has open task
 * issues, and also while any of its contracts has no task issue yet; past the grace period that
 * stops (alert): the issues jobs failed, and the next language must not start on top of it.
 */
function nextLanguage({ policy, onboarded, candidates, issues, openPRs, contracts, onboardMerges, ledger, costs, incidents = [], now }) {
    if (!policy || !Array.isArray(policy.languages) || policy.languages.length === 0) return { action: "stop", reason: "no_onboarding_policy" };
    // External locales (generated on main, never factory-run: vi) are neither picked nor counted.
    const ext = policy.external_locales ?? [];
    if (!Array.isArray(ext) || !ext.every((c) => typeof c === "string" && /^[a-z]{2}(?:-[a-z]{4})?$/.test(c))) return { action: "stop", reason: "no_onboarding_policy" };
    const external = new Set(ext);
    const stop = policy.stop || {};
    if (!Array.isArray(issues) || !Array.isArray(openPRs)) return { action: "wait", reason: `inputs_unreadable:${!Array.isArray(issues) ? "issues" : "prs"}` };
    if (openPRs.length > 0) return { action: "wait", reason: `onboarding_pr_open:${openPRs.join(",")}` };
    const generated = new Set(onboarded.filter((c) => !external.has(c)));
    const codeOf = (task) => String(task).split("/")[0];
    const ours = issues.filter((i) => generated.has(codeOf(i.id)));
    const open = ours.filter((i) => i.state === undefined || i.state === "open");
    const needsHuman = open.filter((i) => i.labels.includes("needs-human")).length;
    if (needsHuman >= (stop.max_open_needs_human ?? 2)) return { action: "stop", reason: `needs_human_cluster:${needsHuman}` };
    // Every generated contract needs its task issue before the language counts as done.
    if (!Array.isArray(contracts) || !Array.isArray(onboardMerges)) return { action: "wait", reason: `inputs_unreadable:${!Array.isArray(contracts) ? "contracts" : "onboard_merges"}` };
    if (!ledger || !Array.isArray(ledger.runs) || !Array.isArray(ledger.merged)) return { action: "wait", reason: "ledger_unreadable" };
    if (!(costs instanceof Map)) return { action: "wait", reason: "costs_unreadable" };
    const issued = new Set(ours.map((i) => i.id));
    const unissued = [...new Set(contracts.filter((id) => generated.has(codeOf(id)) && !issued.has(id)).map(codeOf))].sort();
    if (unissued.length > 0) {
        const t = Date.parse(now);
        const late = unissued.filter((c) => {
            const merged = onboardMerges.filter((m) => m && m.code === c && typeof m.merged_at === "string").map((m) => Date.parse(m.merged_at)).filter(Number.isFinite);
            // No record of its merge: as good as late (never onboard on top of it).
            return !Number.isFinite(t) || merged.length === 0 || t - Math.max(...merged) > TASK_ISSUES_GRACE_HOURS * 3600_000;
        });
        if (late.length > 0) return { action: "stop", reason: `task_issues_missing:${late.join(",")}` };
        return { action: "wait", reason: `task_issues_pending:${unissued.join(",")}` };
    }
    const covered = coveredRuns(ledger, generated);
    const behind = covered.filter((r) => !costs.has(r.run_id)).map((r) => `run:${r.run_id}`);
    const merged = ledger.merged.filter((m) => m && typeof m.task === "string" && generated.has(codeOf(m.task)));
    for (const m of merged) if (typeof m.zero_touch !== "boolean") behind.push(`merged:${m.task}`);
    if (behind.length > 0) return { action: "wait", reason: `records_behind:${behind.length}`, behind: behind.slice(0, 20) };
    const spent = covered.reduce((n, r) => n + costs.get(r.run_id).aic, 0);
    if (!Number.isFinite(stop.budget_aic)) return { action: "stop", reason: "no_budget" };
    if (spent >= stop.budget_aic) return { action: "stop", reason: `budget_spent:${Math.round(spent)}/${stop.budget_aic}` };
    // First try: one implement run (incident-excused attempts aside), no repair, PR merged zero-touch.
    const incidentAt = new Map();
    for (const i of incidents) {
        if (i && typeof i.task === "string" && typeof i.labeled_at === "string" && !(incidentAt.get(i.task) >= i.labeled_at)) incidentAt.set(i.task, i.labeled_at);
    }
    const byTask = new Map();
    for (const m of merged) byTask.set(m.task, [...(byTask.get(m.task) || []), m]);
    let firstTry = 0;
    for (const [task, prs] of byTask) {
        const runs = covered.filter((r) => r.task === task);
        const implement = runs.filter((r) => r.workflow === "implement").sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
        // The attempt whose PR merged: the newest implement run started before that PR was opened.
        const pr = [...prs].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).pop();
        const winner = implement.filter((r) => !(String(r.created_at) > String(pr.created_at))).pop();
        const counted = implement.filter((r) => r === winner || !(incidentAt.has(task) && String(r.created_at) < incidentAt.get(task)));
        if (counted.length === 1 && !runs.some((r) => r.workflow === "repair") && prs.some((p) => p.zero_touch === true)) firstTry++;
    }
    const minSample = stop.min_sample ?? 5;
    const minRate = stop.min_first_try_merge_rate ?? 0.8;
    if (byTask.size >= minSample && firstTry / byTask.size < minRate) return { action: "stop", reason: `first_try_rate:${firstTry}/${byTask.size}` };
    const inFlight = new Set(open.map((i) => codeOf(i.id)));
    if (inFlight.size >= (policy.max_languages_in_flight ?? 1)) return { action: "wait", reason: `in_flight:${[...inFlight].sort().join(",")}` };
    const code = policy.languages.find((c) => candidates.includes(c) && !external.has(c));
    if (!code) return { action: "stop", reason: "all_onboarded" };
    return { action: "onboard", code, spent: Math.round(spent), first_try: `${firstTry}/${byTask.size}` };
}

const LEDGER_TASK = /^(?:Implement|Repair|Triage) ([a-z0-9-]+\/[a-z0-9_-]+) /;

/**
 * The ledger runs whose cost counts toward the generated locales: their tasks' agent runs that
 * weren't skipped, and every review run since the first of those (a review names no task; one that
 * started before can't be ours). [{run_id, workflow, task (null for a review), created_at}]
 */
function coveredRuns(ledger, generated) {
    const codeOf = (task) => String(task).split("/")[0];
    const taskOf = (r) => (LEDGER_TASK.exec((r && r.title) || "") || [])[1];
    const ours = ledger.runs.filter((r) => r && r.conclusion !== "skipped" && taskOf(r) && generated.has(codeOf(taskOf(r))));
    const since = ours.map((r) => String(r.created_at || "")).sort()[0] ?? null;
    // A review names no task in a way the ledger reads, except the canary's `Review drill/…` runs: not ours.
    const reviews = since === null ? [] : ledger.runs.filter((r) => r && r.workflow === "review" && r.conclusion !== "skipped" && !/^Review drill\//.test(r.title || "") && !(String(r.created_at || "") < since));
    return [...ours.map((r) => ({ run_id: r.run_id, workflow: r.workflow, task: taskOf(r), created_at: r.created_at })), ...reviews.map((r) => ({ run_id: r.run_id, workflow: "review", task: null, created_at: r.created_at }))];
}

/**
 * Each run's cost from the controller's audit log events (log order): its newest `run_spend` (a
 * finished run's final figure, full cost: agent, threat detection and evals); else its newest
 * `spend_snapshot` entry (a run still in flight at the day's last snapshot stays at its reservation:
 * an overestimate). Only real (dry_run: false) measurements. A run counted at its bound because a
 * usage file was missing (status `bounded`) counts at the larger of its readable usage files and its
 * agent artifact's own figure, which gh-aw Outcomes reports: never less than the figure this rule
 * read before (#337). With neither, at its bound. Map run_id → {aic, status, source}.
 */
function runCosts(events) {
    const final = new Map();
    const snap = new Map();
    const cost = (r) => {
        if (r.status !== "bounded") return r.aic;
        const seen = [r.readable_aic, r.observed_aic].filter((n) => Number.isFinite(n) && n > 0);
        return seen.length ? Math.max(...seen) : r.aic;
    };
    for (const e of events) {
        if (!e || !e.payload || e.payload.dry_run !== false) continue;
        if (e.type === "run_spend" && Number.isSafeInteger(e.payload.run_id) && Number.isFinite(e.payload.aic) && e.payload.aic >= 0) {
            final.set(e.payload.run_id, { aic: cost(e.payload), status: e.payload.status, source: "run_spend" });
        } else if (e.type === "spend_snapshot" && Array.isArray(e.payload.runs)) {
            for (const r of e.payload.runs) if (r && Number.isSafeInteger(r.run_id) && Number.isFinite(r.aic) && r.aic >= 0) snap.set(r.run_id, { aic: cost(r), status: r.status, source: "spend_snapshot" });
        }
    }
    for (const [id, c] of snap) if (!final.has(id)) final.set(id, c);
    return final;
}

/** Bot or person, as gh-aw's zero_touch: an actor whose GraphQL type is Bot, or a login or commit email of an App's bot. */
const isBot = (a) => !!a && (a.__typename === "Bot" || /\[bot\]$/.test(a.login || ""));

/**
 * gh-aw's zero_touch for a merged agent PR (GraphQL fields: comments, reviews, commits): no comment,
 * review or commit by anyone but a bot. A commit counts as a bot's only when its author is a bot
 * account or its email is a bot's noreply address; an unknown author is a person (stricter).
 * Null if a list is missing or truncated (can't tell).
 */
function zeroTouch(pr) {
    const list = (c) => (c && Array.isArray(c.nodes) && !(c.pageInfo && c.pageInfo.hasNextPage) ? c.nodes : null);
    const comments = list(pr && pr.comments);
    const reviews = list(pr && pr.reviews);
    const commits = list(pr && pr.commits);
    if (!comments || !reviews || !commits) return null;
    const botCommit = (n) => {
        const a = n && n.commit && n.commit.author;
        return !!a && (isBot(a.user) || /\[bot\]@users\.noreply\.github\.com$/.test(a.email || ""));
    };
    return comments.every((c) => isBot(c && c.author)) && reviews.every((r) => isBot(r && r.author)) && commits.every(botCommit);
}

module.exports.nextLanguage = nextLanguage;
module.exports.coveredRuns = coveredRuns;
module.exports.runCosts = runCosts;
module.exports.zeroTouch = zeroTouch;
module.exports.TASK_ISSUES_GRACE_HOURS = TASK_ISSUES_GRACE_HOURS;
