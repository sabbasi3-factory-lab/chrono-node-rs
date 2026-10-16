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
const REGISTRY_DIR = /^src\/(common|locales\/[a-z]+)\/(parsers|refiners)\/(?!mod\.rs$)[a-z0-9][a-z0-9_]*\.rs$/;
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
        add("step", t.step, t.id);
        add("rust", t.rust, t.id);
        if (!REGISTRY_DIR.test(t.rust || "")) problems.push(`${t.id}: rust path must be one file in a parsers/ or refiners/ dir`);
        const src = `${taskmap.upstream_root}/${t.source}`;
        const text = upstreamFiles.get(src);
        if (text === undefined) problems.push(`${t.id}: missing upstream file ${src}`);
        else if (!new RegExp(`class\\s+${t.step}\\b`).test(text)) problems.push(`${t.id}: ${src} has no class ${t.step}`);
        if (!t.area || !/^[a-z0-9-]+$/.test(t.area)) problems.push(`${t.id}: bad area`);
        const kind = /\/parsers\//.test(t.rust || "") ? "parsers" : "refiners";
        if (!/\/(parsers|refiners)\//.test(t.source || "") || !t.source.includes(`/${kind}/`)) {
            problems.push(`${t.id}: source and rust path disagree on parser/refiner`);
        }
    }
    // Every step of every English configuration must be done or a task.
    for (const [name, cfg] of Object.entries(configurations)) {
        for (const s of [...cfg.parsers, ...cfg.refiners]) {
            if (!seen.step.has(s.name)) problems.push(`${name} step ${s.name} is neither done nor a task`);
        }
    }
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

/** Build all contracts (sorted by id). */
function buildContracts({ taskmap, pin, tiers, cases }) {
    const doneSteps = new Set((taskmap.done || []).map((d) => d.step));
    const byStep = new Map(taskmap.tasks.map((t) => [t.step, t]));
    const facts = goldenFacts([...byStep.keys()], doneSteps, cases);

    const deps = new Map();
    for (const t of taskmap.tasks) {
        const extra = facts.get(t.step).extra;
        const ids = extra.map((s) => {
            const dep = byStep.get(s);
            if (!dep) throw new Error(`${t.id}: golden data needs ${s}, which is neither done nor a task`);
            return dep.id;
        });
        deps.set(t.id, [...new Set(ids)].sort());
    }
    assertAcyclic(deps);

    // Priority 1 = most golden cases; ties by id.
    const ranked = [...taskmap.tasks].sort((a, b) => facts.get(b.step).count - facts.get(a.step).count || (a.id < b.id ? -1 : 1));
    const priority = new Map(ranked.map((t, i) => [t.id, i + 1]));
    const d = taskmap.acceptance.differential;

    return [...taskmap.tasks]
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map((t) => {
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
                ],
                golden_cases: f.count,
            };
        });
}

function renderContract(c) {
    const header = [
        "# Generated by scripts/seed-backlog/seed.js from scripts/seed-backlog/taskmap.yaml.",
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
    return contracts.map((c) => ({
        marker: MARKER(c.id),
        title: `${c.id}: ${c.title}`,
        labels: ["factory:task", `tier:${c.tier}`, `area:${c.area}`],
        blocked_by: c.depends_on,
        body: [
            MARKER(c.id),
            `Port \`${c.upstream_class}\` from \`${c.source}\` (chrono-node @ \`${c.source_sha.slice(0, 7)}\`).`,
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

module.exports = {
    MARKER,
    globToRegExp,
    tierFor,
    validate,
    goldenFacts,
    assertAcyclic,
    buildContracts,
    renderContract,
    planIssues,
    isManagedLabel,
    mergeLabels,
};
