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
};

/**
 * Which language to onboard next (the scheduled pipeline), or why not. Pure.
 *   policy:     factory policies/onboarding.yaml at the pinned version, or null
 *   onboarded:  codes of the generated locales on main
 *   candidates: upstream codes not onboarded yet
 *   outcomes:   outcomes.json (gh-aw Outcomes per agent run), or null if unreadable
 *   issues:     open factory:task issues [{id, labels}] (id from the marker)
 *   openPRs:    open onboarding PRs (branch factory/onboard/<code>) [code]
 * Returns {action: "onboard", code} | {action: "wait" | "stop", reason}.
 */
function nextLanguage({ policy, onboarded, candidates, outcomes, issues, openPRs }) {
    if (!policy || !Array.isArray(policy.languages) || policy.languages.length === 0) return { action: "stop", reason: "no_onboarding_policy" };
    const stop = policy.stop || {};
    if (openPRs.length > 0) return { action: "wait", reason: `onboarding_pr_open:${openPRs.join(",")}` };
    const generated = new Set(onboarded);
    const codeOf = (task) => String(task).split("/")[0];
    const ours = issues.filter((i) => generated.has(codeOf(i.id)));
    const needsHuman = ours.filter((i) => i.labels.includes("needs-human")).length;
    if (needsHuman >= (stop.max_open_needs_human ?? 2)) return { action: "stop", reason: `needs_human_cluster:${needsHuman}` };
    if (!outcomes || !Array.isArray(outcomes.runs)) return { action: "wait", reason: "outcomes_unreadable" };
    const runs = outcomes.runs.filter((r) => r && typeof r.task === "string" && generated.has(codeOf(r.task)) && !r.drill);
    // A run without a known cost means the spend is unknown, never zero.
    if (runs.some((r) => !Number.isFinite(r.aic))) return { action: "wait", reason: "spend_unknown" };
    const spent = runs.reduce((n, r) => n + r.aic, 0);
    if (!Number.isFinite(stop.budget_aic)) return { action: "stop", reason: "no_budget" };
    if (spent >= stop.budget_aic) return { action: "stop", reason: `budget_spent:${Math.round(spent)}/${stop.budget_aic}` };
    // First try: the task's only agent run is its first implement, and that PR was accepted zero-touch.
    const byTask = new Map();
    for (const r of runs) byTask.set(r.task, [...(byTask.get(r.task) || []), r]);
    let merged = 0;
    let firstTry = 0;
    for (const list of byTask.values()) {
        const prs = list.flatMap((r) => (r.items || []).filter((i) => i.type === "create_pull_request"));
        if (!prs.some((i) => i.outcome_status === "accepted")) continue;
        merged++;
        const implement = list.filter((r) => r.workflow === "implement");
        if (implement.length === 1 && !list.some((r) => r.workflow === "repair") && prs.some((i) => i.outcome_status === "accepted" && i.zero_touch === true)) firstTry++;
    }
    const minSample = stop.min_sample ?? 5;
    const minRate = stop.min_first_try_merge_rate ?? 0.8;
    if (merged >= minSample && firstTry / merged < minRate) return { action: "stop", reason: `first_try_rate:${firstTry}/${merged}` };
    const inFlight = new Set(ours.map((i) => codeOf(i.id)));
    if (inFlight.size >= (policy.max_languages_in_flight ?? 1)) return { action: "wait", reason: `in_flight:${[...inFlight].sort().join(",")}` };
    const code = policy.languages.find((c) => candidates.includes(c));
    if (!code) return { action: "stop", reason: "all_onboarded" };
    return { action: "onboard", code, spent: Math.round(spent), first_try: `${firstTry}/${merged}` };
}

module.exports.nextLanguage = nextLanguage;
