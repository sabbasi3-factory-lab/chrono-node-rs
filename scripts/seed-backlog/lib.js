"use strict";
// Pure, deterministic logic of the seed script. No I/O here: seed.js loads the inputs.

const YAML = require("yaml");

const MARKER = (id) => `<!-- factory-task: ${id} -->`;

/** Glob -> RegExp: `**` crosses directories, `*` doesn't. Same semantics as harness/gates/scope.js. */
function globToRegExp(glob) {
    let re = "";
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === "*" && glob[i + 1] === "*") {
            if (glob[i + 2] === "/") {
                re += "(?:.*/)?";
                i += 2;
            } else {
                re += ".*";
                i += 1;
            }
        } else if (c === "*") re += "[^/]*";
        else if (c === "?") re += "[^/]";
        else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(`^${re}$`);
}
const matchesAny = (path, globs) => (globs || []).some((g) => globToRegExp(g).test(path));

/**
 * Contract tier for a set of paths from tiers.yaml. auto-strict paths use `start_as` (human in
 * Stage 1). A path in no tier is human (fail closed).
 */
function tierFor(paths, tiers) {
    const t = tiers.tiers;
    let result = "auto";
    for (const p of paths) {
        let tier;
        if (matchesAny(p, t.human && t.human.paths)) tier = "human";
        else if (matchesAny(p, t["auto-strict"] && t["auto-strict"].paths)) tier = t["auto-strict"].start_as || "auto-strict";
        else if (matchesAny(p, t.auto && t.auto.paths)) tier = "auto";
        else tier = "human";
        if (tier !== "auto") result = tier;
    }
    return result;
}

// Same rule as build.rs: snake_case files, excluding `mod.rs` and names starting with `_`
// (those are skipped by the registry, so a step there could never register).
const REGISTRY_DIR = /^src\/(common|locales\/[a-z_]+)\/(parsers|refiners)\/(?!mod\.rs$)[a-z0-9][a-z0-9_]*\.rs$/;
// A generated locale's support file (constants, a shared base): one file directly in the locale
// directory, declared by build.rs. `mod.rs` and `configuration.rs` are the generator's.
const SUPPORT_FILE = /^src\/locales\/([a-z_]+)\/(?!mod\.rs$|configuration\.rs$)[a-z0-9][a-z0-9_]*\.rs$/;
// Generated tasks' priorities start here, after every hand-mapped task, and are ranked within their
// locale, so onboarding a language never re-ranks (and so never changes) an existing contract.
const GENERATED_PRIORITY_BASE = 1000;
const TASK_ID = /^[a-z0-9-]+\/[a-z0-9-]+$/;

/**
 * Validate the task map against upstream and golden data. Returns a list of problems.
 * @param inputs {taskmap, upstreamFiles: Map<path, text>, configurations, cases}
 */
function validate({ taskmap, upstreamFiles, configurations }) {
    const problems = [];
    const seen = { id: new Set(), step: new Set(), rust: new Set() };
    const add = (kind, v, where) => {
        if (seen[kind].has(v)) problems.push(`duplicate ${kind} ${v} (${where})`);
        seen[kind].add(v);
    };
    for (const d of taskmap.done || []) {
        add("step", d.step, "done");
        add("rust", d.rust, "done");
    }
    for (const t of taskmap.tasks || []) {
        if (!TASK_ID.test(t.id || "")) problems.push(`bad task id ${JSON.stringify(t.id)}`);
        add("id", t.id, t.id);
        if (t.kind === "support") {
            problems.push(...supportProblems(t, taskmap, upstreamFiles));
            add("rust", t.rust, t.id);
            continue;
        }
        if (t.kind !== undefined) problems.push(`${t.id}: unknown kind ${JSON.stringify(t.kind)}`);
        add("step", t.step, t.id);
        add("rust", t.rust, t.id);
        if (!REGISTRY_DIR.test(t.rust || "")) problems.push(`${t.id}: rust path must be one file in a parsers/ or refiners/ dir`);
        const src = `${taskmap.upstream_root}/${t.source}`;
        const text = upstreamFiles.get(src);
        if (text === undefined) problems.push(`${t.id}: missing upstream file ${src}`);
        // `class` overrides the declared class name where upstream reuses one (the step keeps the
        // file name, as harness/lib/serialize.js names it).
        else if (!new RegExp(`class\\s+${t.class || t.step}\\b`).test(text)) problems.push(`${t.id}: ${src} has no class ${t.class || t.step}`);
        if (!t.area || !/^[a-z0-9-]+$/.test(t.area)) problems.push(`${t.id}: bad area`);
        if (t.unit !== undefined) {
            const u = t.unit;
            // `test` is the #[test] fn the gates check for, so it must be a unique snake_case name.
            const casesOk =
                u &&
                Array.isArray(u.cases) &&
                u.cases.length > 0 &&
                u.cases.every((c) => c && typeof c.test === "string" && /^[a-z_][a-z0-9_]*$/.test(c.test) && c.expect && typeof c.expect === "object") &&
                new Set(u.cases.map((c) => c.test)).size === u.cases.length;
            if (!u || typeof u.requirement !== "string" || !u.requirement.trim() || !casesOk) {
                problems.push(`${t.id}: unit must be {requirement, cases: [{test: <unique snake_case>, ..., expect}]}`);
            }
        }
        const kind = /\/parsers\//.test(t.rust || "") ? "parsers" : "refiners";
        if (!/\/(parsers|refiners)\//.test(t.source || "") || !t.source.includes(`/${kind}/`)) {
            problems.push(`${t.id}: source and rust path disagree on parser/refiner`);
        }
    }
    for (const t of taskmap.tasks || []) {
        for (const n of t.needs || []) {
            const dep = (taskmap.tasks || []).find((x) => x.id === n);
            if (!dep || dep.kind !== "support" || dep.locale !== t.locale) problems.push(`${t.id}: needs ${n}, not a support task of its locale`);
        }
    }
    // Every step of every named configuration (English, German, French, Swedish, Portuguese, Spanish, Japanese) must be done or a task.
    for (const [name, cfg] of Object.entries(configurations)) {
        for (const s of [...cfg.parsers, ...cfg.refiners]) {
            if (!seen.step.has(s.name)) problems.push(`${name} step ${s.name} is neither done nor a task`);
        }
    }
    return problems;
}

/** A support task (generated locales only): `{id, kind: support, locale, source, rust, area, unit}`. */
function supportProblems(t, taskmap, upstreamFiles) {
    const problems = [];
    const m = SUPPORT_FILE.exec(t.rust || "");
    if (!t.locale || !m || m[1] !== t.locale) problems.push(`${t.id}: a support task's rust path is one file directly in src/locales/<its locale>/`);
    if (t.step !== undefined || t.class !== undefined) problems.push(`${t.id}: a support task has no step`);
    if (!t.area || !/^[a-z0-9-]+$/.test(t.area)) problems.push(`${t.id}: bad area`);
    const src = `${taskmap.upstream_root}/${t.source}`;
    if (!upstreamFiles.has(src)) problems.push(`${t.id}: missing upstream file ${src}`);
    // Its acceptance: unit cases recorded from chrono-node (constants), or, for a shared base with
    // nothing to record, a requirement its dependents' golden cases check.
    const hasUnit = Boolean(t.unit) && Array.isArray(t.unit.cases) && t.unit.cases.length > 0 && typeof t.unit.requirement === "string";
    const hasRequirement = typeof t.requirement === "string" && t.requirement.trim() !== "";
    if (hasUnit === hasRequirement) problems.push(`${t.id}: a support task needs exactly one of unit {requirement, cases} or requirement`);
    return problems;
}

/**
 * For each task step: the golden areas that need it, how many cases need it, and the cheapest
 * extra unported steps (the case needing the fewest other unported steps; ties broken by name).
 */
function goldenFacts(steps, doneSteps, cases) {
    const facts = new Map();
    for (const step of steps) {
        const areas = new Set();
        let count = 0;
        let best = null;
        for (const c of cases) {
            if (!c.requires.includes(step)) continue;
            count++;
            areas.add(c.area);
            const others = c.requires.filter((s) => s !== step && !doneSteps.has(s)).sort();
            const key = others.join(",");
            if (best === null || others.length < best.length || (others.length === best.length && key < best.join(","))) {
                best = others;
            }
        }
        facts.set(step, { areas: [...areas].sort(), count, extra: best || [] });
    }
    return facts;
}

/** Topological check; throws on a cycle. */
function assertAcyclic(deps) {
    const state = new Map();
    const visit = (id, path) => {
        if (state.get(id) === "done") return;
        if (state.get(id) === "active") throw new Error(`dependency cycle: ${[...path, id].join(" -> ")}`);
        state.set(id, "active");
        for (const d of deps.get(id) || []) visit(d, [...path, id]);
        state.set(id, "done");
    };
    for (const id of deps.keys()) visit(id, []);
}

/**
 * Build all contracts (sorted by id). Hand-mapped tasks (no `locale`) see only the hand-scaffolded
 * golden groups' cases; a generated locale's tasks see only their own group's. So onboarding a
 * language adds contracts and never changes one (a changed contract would mark in-flight PRs
 * stale).
 */
function buildContracts({ taskmap, pin, tiers, cases }) {
    const doneSteps = new Set((taskmap.done || []).map((d) => d.step));
    const stepTasks = taskmap.tasks.filter((t) => t.kind !== "support");
    const byStep = new Map(stepTasks.map((t) => [t.step, t]));
    const generatedGroups = new Set(taskmap.tasks.map((t) => t.locale).filter(Boolean));
    const caseScope = (t) => cases.filter((c) => (t.locale ? c.group === t.locale : !generatedGroups.has(c.group)));
    const facts = new Map();
    for (const t of stepTasks) facts.set(t.step, goldenFacts([t.step], doneSteps, caseScope(t)).get(t.step));

    const deps = new Map();
    for (const t of taskmap.tasks) {
        if (t.kind === "support") {
            deps.set(t.id, [...(t.needs || [])].sort());
            continue;
        }
        const extra = facts.get(t.step).extra;
        const ids = extra.map((s) => {
            const dep = byStep.get(s);
            if (!dep) throw new Error(`${t.id}: golden data needs ${s}, which is neither done nor a task`);
            return dep.id;
        });
        deps.set(t.id, [...new Set([...ids, ...(t.needs || [])])].sort());
    }
    assertAcyclic(deps);

    // Priority 1 = most golden cases; ties by id. Generated locales: their support tasks first, then
    // their steps by golden count, after GENERATED_PRIORITY_BASE (see above).
    const byCount = (a, b) => facts.get(b.step).count - facts.get(a.step).count || (a.id < b.id ? -1 : 1);
    const priority = new Map(stepTasks.filter((t) => !t.locale).sort(byCount).map((t, i) => [t.id, i + 1]));
    for (const locale of [...generatedGroups].sort()) {
        const own = taskmap.tasks.filter((t) => t.locale === locale);
        const support = own.filter((t) => t.kind === "support").sort((a, b) => (a.id < b.id ? -1 : 1));
        const steps = own.filter((t) => t.kind !== "support").sort(byCount);
        [...support, ...steps].forEach((t, i) => priority.set(t.id, GENERATED_PRIORITY_BASE + i));
    }
    const d = taskmap.acceptance.differential;

    return [...taskmap.tasks]
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map((t) => {
            if (t.kind === "support") return supportContract(t, { taskmap, pin, tiers, priority: priority.get(t.id), depends: deps.get(t.id) });
            const f = facts.get(t.step);
            if (f.count === 0) throw new Error(`${t.id}: no golden case needs ${t.step}`);
            return {
                id: t.id,
                title: `Port ${t.step}`,
                tier: tierFor([t.rust], tiers),
                area: t.area,
                priority: priority.get(t.id),
                source: `${taskmap.upstream_root}/${t.source}`,
                source_sha: pin.commit,
                upstream_class: t.step,
                scope: [t.rust],
                depends_on: deps.get(t.id),
                acceptance: [
                    { golden: { step: t.step, areas: f.areas } },
                    { differential: { phrases: d.phrases, seed: d.seed, match: `chrono-node@${pin.commit.slice(0, 7)}` } },
                    { clippy: taskmap.acceptance.clippy },
                    { public_api: taskmap.acceptance.public_api },
                    // Behaviour golden data can't reach (e.g. constructor arguments upstream never passes).
                    ...(t.unit ? [{ unit: t.unit }] : []),
                ],
                golden_cases: f.count,
            };
        });
}

/**
 * A generated locale's support file (constants, a shared base): no step and no golden case of its
 * own, so its acceptance is the unit cases recorded from the pinned chrono-node (onboard.js). The
 * steps that import it depend on it, and their golden cases check it again.
 */
function supportContract(t, { taskmap, pin, tiers, priority, depends }) {
    return {
        id: t.id,
        title: `Port ${t.source.split("/").pop()} (${t.locale})`,
        tier: tierFor([t.rust], tiers),
        area: t.area,
        priority,
        source: `${taskmap.upstream_root}/${t.source}`,
        source_sha: pin.commit,
        upstream_class: t.source.split("/").pop().replace(/\.ts$/, ""),
        scope: [t.rust],
        depends_on: depends,
        acceptance: [
            { clippy: taskmap.acceptance.clippy },
            { public_api: taskmap.acceptance.public_api },
            t.unit ? { unit: t.unit } : { requirement: t.requirement },
        ],
        golden_cases: 0,
    };
}

/**
 * Fix tasks from the monitor / bug intake: one contract per fix case in tests/golden/fixes/.
 * Scope: the Rust files of every step chrono-node used for the case (which one diverges is for
 * the fix to find). Area: the first of those steps' task areas (so it serializes with work on the
 * same files), else `<lang>-fixes`. Priority 0: fixes go before new ports. The golden "step" is the
 * fix id, which the Rust golden runner treats as ported once `// factory-fix: <id>` exists.
 */
function buildFixContracts({ taskmap, pin, tiers, fixes }) {
    const steps = new Map();
    for (const d of taskmap.done || []) steps.set(d.step, { rust: d.rust, area: null, source: null });
    for (const t of taskmap.tasks) if (t.kind !== "support") steps.set(t.step, { rust: t.rust, area: t.area, source: `${taskmap.upstream_root}/${t.source}` });
    const d = taskmap.acceptance.differential;
    return (fixes || [])
        .map((f) => {
            if (!TASK_ID.test(f.id) || !/^[a-z]{2}\/fix-[0-9a-f]{8}$/.test(f.id)) throw new Error(`bad fix id ${f.id}`);
            const known = f.steps.map((s) => {
                const k = steps.get(s);
                if (!k) throw new Error(`${f.id}: step ${s} is neither done nor a task`);
                return k;
            });
            if (known.length === 0) throw new Error(`${f.id}: no step produced the expected result`);
            const scope = [...new Set(known.map((k) => k.rust))].sort();
            const area = (known.find((k) => k.area) || {}).area || `${f.id.split("/")[0]}-fixes`;
            const issue = Number.isSafeInteger(f.issue) && f.issue > 0 ? f.issue : null;
            return {
                id: f.id,
                title: `Fix a mismatch with chrono-node (${f.config})`,
                tier: tierFor(scope, tiers),
                area,
                priority: 0,
                ...(known.some((k) => k.source) ? { source: known.map((k) => k.source).find(Boolean) } : {}),
                source_sha: pin.commit,
                upstream_class: f.id,
                scope,
                depends_on: [],
                acceptance: [
                    { golden: { step: f.id, areas: [f.area] } },
                    { differential: { phrases: d.phrases, seed: d.seed, match: `chrono-node@${pin.commit.slice(0, 7)}` } },
                    { clippy: taskmap.acceptance.clippy },
                    { public_api: taskmap.acceptance.public_api },
                    {
                        fix: {
                            ...(issue ? { issue } : {}),
                            ...(f.signature ? { signature: f.signature } : {}),
                            steps: f.steps,
                            requirement:
                                `The Rust port and chrono-node disagree on the golden case in tests/golden/${f.area}.json` +
                                `${issue ? ` (reported in #${issue})` : ""}. Find which scope file diverges from its upstream step and make the ` +
                                `port match upstream there, keeping every other golden case passing. Then add the line comment ` +
                                `\`// factory-fix: ${f.id}\` next to the change: the golden runner checks this case only once that marker exists.`,
                        },
                    },
                ],
                golden_cases: 1,
            };
        })
        .sort((a, b) => (a.id < b.id ? -1 : 1));
}

function renderContract(c) {
    const header = [
        fixOf(c)
            ? "# Generated by scripts/seed-backlog/seed.js from tests/golden/fixes/ (the intake's harness/golden/fixes/ input)."
            : "# Generated by scripts/seed-backlog/seed.js from scripts/seed-backlog/taskmap.yaml.",
        "# Do not edit by hand: change the task map (by reviewed PR) and re-run the script.",
        "",
    ].join("\n");
    return header + YAML.stringify(c, { lineWidth: 0, flowCollectionPadding: false, collectionStyle: "block" });
}

/** Labels the seed script manages; everything else on an issue (e.g. factory:ready) is kept. */
const isManagedLabel = (name) => name === "factory:task" || name.startsWith("tier:") || name.startsWith("area:");

/** Labels for an existing issue on re-run: keep unmanaged labels, replace managed ones. */
function mergeLabels(existing, generated) {
    const kept = existing.filter((l) => !isManagedLabel(l));
    return [...new Set([...kept, ...generated])].sort();
}

/** The issue each contract becomes (after the contracts PR is merged). Pure; no network. */
function planIssues(contracts, repo) {
    return contracts.map((c) => (fixOf(c) ? planFixIssue(c, fixOf(c), repo) : {
        marker: MARKER(c.id),
        title: `${c.id}: ${c.title}`,
        labels: ["factory:task", `tier:${c.tier}`, `area:${c.area}`],
        blocked_by: c.depends_on,
        body: [
            MARKER(c.id),
            `Port \`${c.upstream_class}\` from \`${c.source}\` (chrono-node @ \`${c.source_sha.slice(0, 7)}\`).`,
            ...(c.golden_cases === 0 ? ["", "A support file of a generated locale: no golden case of its own; its acceptance is the contract's unit cases, and the steps that import it depend on it."] : []),
            "",
            `- Contract: [\`contracts/${c.id}.yaml\`](https://github.com/${repo}/blob/main/contracts/${c.id}.yaml)`,
            `- Scope: ${c.scope.map((s) => `\`${s}\``).join(", ")}`,
            `- Tier: \`${c.tier}\` · Area: \`${c.area}\` · Priority: ${c.priority}`,
            `- Depends on: ${c.depends_on.length ? c.depends_on.map((d) => `\`${d}\``).join(", ") : "none"}`,
            "",
            "Follow `PORTING.md`. The contract is the definition of done; this issue text is not.",
            "",
            "_Created by the seed script. Add `factory:ready` to let the controller pick it up._",
        ].join("\n"),
    }));
}

const fixOf = (c) => ((c.acceptance || []).find((a) => a && a.fix) || {}).fix || null;

/** A fix task's issue: same labels and marker, plus the monitor signature (so the monitor dedupes on it). */
function planFixIssue(c, fix, repo) {
    return {
        marker: MARKER(c.id),
        title: `${c.id}: ${c.title}`,
        labels: ["factory:task", `tier:${c.tier}`, `area:${c.area}`],
        blocked_by: c.depends_on,
        body: [
            MARKER(c.id),
            ...(fix.signature ? [`<!-- factory-monitor: ${fix.signature} -->`] : []),
            `Fix a mismatch with chrono-node @ \`${c.source_sha.slice(0, 7)}\`${fix.issue ? `, reported in #${fix.issue}` : ""}.`,
            "",
            `- Contract: [\`contracts/${c.id}.yaml\`](https://github.com/${repo}/blob/main/contracts/${c.id}.yaml)`,
            `- Golden case: \`tests/golden/${c.acceptance[0].golden.areas[0]}.json\``,
            `- Scope: ${c.scope.map((s) => `\`${s}\``).join(", ")}`,
            `- Tier: \`${c.tier}\` · Area: \`${c.area}\` · Priority: ${c.priority}`,
            "",
            "Follow `PORTING.md`. The contract is the definition of done; this issue text is not.",
            "",
            "_Created by the intake from a confirmed port bug._",
        ].join("\n"),
    };
}

/**
 * Labels to create: every required one (`{name, color, description}`) whose name isn't in `existing`,
 * in the order given, without duplicates. Existing labels are never edited.
 */
function missingLabels(required, existing) {
    const have = new Set(existing);
    const seen = new Set();
    return required.filter((l) => !have.has(l.name) && !seen.has(l.name) && seen.add(l.name));
}

/**
 * Merge the hand-written task map with the generated locales' fragments (taskmap.d/<module>.yaml,
 * harness/onboard/onboard.js). A fragment may only add tasks for its own locale.
 */
function mergeTaskmaps(base, fragments) {
    const out = { ...base, tasks: [...(base.tasks || [])] };
    for (const [file, f] of fragments) {
        const where = `taskmap.d/${file}`;
        if (!f || f.version !== 1 || typeof f.locale !== "string" || !Array.isArray(f.tasks) || file !== `${f.locale}.yaml`) {
            throw new Error(`${where}: want {version: 1, locale: <module>, tasks: [...]} named <module>.yaml`);
        }
        const extra = Object.keys(f).filter((k) => !["version", "locale", "generated_by", "tasks"].includes(k));
        if (extra.length > 0) throw new Error(`${where}: unexpected keys ${extra.join(", ")}`);
        for (const t of f.tasks) {
            if (t.locale !== f.locale) throw new Error(`${where}: task ${t.id} is not for locale ${f.locale}`);
            out.tasks.push(t);
        }
    }
    return out;
}

module.exports = {
    mergeTaskmaps,
    GENERATED_PRIORITY_BASE,
    missingLabels,
    MARKER,
    globToRegExp,
    tierFor,
    validate,
    goldenFacts,
    assertAcyclic,
    buildContracts,
    buildFixContracts,
    renderContract,
    planIssues,
    isManagedLabel,
    mergeLabels,
};
