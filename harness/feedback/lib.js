"use strict";
// Pure logic shared by the nightly monitor and bug intake (no I/O, no AI). See README.md.
const crypto = require("crypto");

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

// Hidden marker: deduplicates mismatches by signature across issues (the bug report and the fix
// task it becomes).
// The monitor's reports and the intake's fix tasks are created by the controller App.
const FACTORY_BOT = "sabbasi3-factory-controller[bot]";

const MONITOR_MARKER = (sig) => `<!-- factory-monitor: ${sig} -->`;
const MONITOR_MARKER_RE = /<!-- factory-monitor: ([0-9a-f]{12}) -->/;

/** One signature per (configuration, steps involved): the same bug found by different phrases dedupes. */
function signature(mismatch) {
    const r = mismatch.requires || { parsers: [], refiners: [] };
    return sha256([mismatch.request.config, [...r.parsers].sort().join(","), [...r.refiners].sort().join(",")].join("|")).slice(0, 12);
}

/** The request without its run-specific id, in a fixed key order (fix ids and dedupe use this). */
function canonicalRequest(req) {
    const ref = req.reference;
    return {
        text: req.text,
        config: req.config,
        reference: { kind: ref.kind, instant: ref.instant, timezone_input: ref.timezone_input ?? null },
        options: req.options && req.options.forwardDate === true ? { forwardDate: true } : {},
    };
}

/** `<lang>/fix-<8 hex>`, stable for the same request: a contract id (contracts/<lang>/fix-….yaml). */
function fixId(req) {
    const c = canonicalRequest(req);
    return `${c.config.split(".")[0]}/fix-${sha256(JSON.stringify(c)).slice(0, 8)}`;
}

/**
 * Mismatches grouped by signature, each with its minimal repro: the shortest text (then the
 * fewest expected results, then the lowest id), so the issue shows the smallest failing case.
 */
function groupMismatches(mismatches) {
    const groups = new Map();
    for (const m of mismatches) {
        const sig = signature(m);
        const g = groups.get(sig) || { signature: sig, count: 0, repro: null };
        g.count++;
        const r = g.repro;
        const better =
            !r ||
            m.request.text.length < r.request.text.length ||
            (m.request.text.length === r.request.text.length &&
                (m.expected.length < r.expected.length || (m.expected.length === r.expected.length && m.request.id < r.request.id)));
        if (better) g.repro = m;
        groups.set(sig, g);
    }
    return [...groups.values()].sort((a, b) => b.count - a.count || (a.signature < b.signature ? -1 : 1));
}

const fence = (lang, body) => "```" + lang + "\n" + body + "\n```";

/** The issue: the same headings as the bug report form (.github/ISSUE_TEMPLATE/port-bug.yml), then evidence. */
function renderMonitorIssue(group, { seed, phrases, runUrl, drill, date }) {
    const m = group.repro;
    const c = canonicalRequest(m.request);
    const steps = [...m.requires.parsers, ...m.requires.refiners];
    const title = `${drill ? "[drill] " : ""}Monitor: ${c.config} differs from chrono-node (${steps.join(", ") || "no steps"})`.slice(0, 200);
    const lines = [
        MONITOR_MARKER(group.signature),
        ...(drill ? ["> **Drill:** this mismatch was planted (`compare.js --plant`). Nothing is wrong with the port.", ""] : []),
        "_Filed by the nightly monitor (plain code, no AI): seeded random phrases compared with the pinned chrono-node._",
        "",
        "### Configuration",
        "",
        c.config,
        "",
        "### Text",
        "",
        fence("text", c.text),
        "",
        "### Reference date",
        "",
        c.reference.instant,
        "",
        "### Reference timezone",
        "",
        c.reference.timezone_input === null ? "_No response_" : String(c.reference.timezone_input),
        "",
        "### Options",
        "",
        fence("json", JSON.stringify(c.options)),
        "",
        "### Expected (chrono-node)",
        "",
        fence("json", JSON.stringify(m.expected)),
        "",
        "### Actual (Rust)",
        "",
        fence("json", JSON.stringify(m.actual)),
        "",
        "### Evidence",
        "",
        `- Steps chrono-node used: ${steps.map((s) => `\`${s}\``).join(", ") || "none"}`,
        `- Phrases with this signature in the run: ${group.count}`,
        `- Signature: \`${group.signature}\` (configuration + steps)`,
        `- Run: ${runUrl || "local"} · seed \`${seed}\` · ${phrases} phrases per language`,
        lastSeen({ date, runUrl, seed, count: group.count }),
        "",
        "Reproduce the whole run on `main`:",
        "",
        fence("sh", `cargo build --bin chrono-rs-json && cd harness && npm ci && npm run build:upstream\nnode compare/compare.js --seed ${seed} --phrases ${phrases}`),
        "",
        "Or only this case: save the line below as `repro.jsonl`, then `node compare/compare.js --requests repro.jsonl`.",
        "",
        fence("json", JSON.stringify({ id: 0, ...c, system_timezone: "UTC" })),
    ];
    return { title, body: lines.join("\n") };
}

/** The one line the monitor rewrites when it sees an already-reported signature again. */
const lastSeen = ({ date, runUrl, seed, count }) => `- Last seen: ${date} · ${count} phrase(s) · seed \`${seed}\` · ${runUrl || "local"}`;
const LAST_SEEN_RE = /^- Last seen: .*$/m;

/** The body with its last-seen line replaced (null if the body has none: not the monitor's own issue). */
function updateLastSeen(body, info) {
    return LAST_SEEN_RE.test(body || "") ? body.replace(LAST_SEEN_RE, lastSeen(info)) : null;
}

// `en.GB.casual`, and generated locales' sublocales (`zh.hans.casual`, harness/onboard). Their fix ids
// keep the two-letter language (`zh/fix-…`), so every fix-id pattern stays as it is.
const CONFIG_RE = /^[a-z]{2}(\.[A-Z]{2}|\.[a-z]{4})?\.(casual|strict)$/;
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

/** The value under a `### Heading` (up to the next heading), or null when absent or empty. */
function section(body, heading) {
    const lines = body.replace(/\r/g, "").split("\n");
    const start = lines.findIndex((l) => l.trim() === `### ${heading}`);
    if (start < 0) return null;
    const out = [];
    for (let i = start + 1; i < lines.length && !lines[i].startsWith("### "); i++) out.push(lines[i]);
    const v = out.join("\n").trim();
    return v === "" || v === "_No response_" ? null : v;
}

/** The content of one fenced block, the plain value if there's no fence, or undefined if malformed. */
function unfence(v) {
    if (v === null) return null;
    const m = /^```[a-z]*\n([\s\S]*?)\n```$/.exec(v);
    if (m) return m[1].includes("```") ? undefined : m[1];
    return v.includes("```") ? undefined : v;
}

// Every reason parseReport can give (the comment step accepts only these).
const ERRORS = {
    body: "the issue body is missing or too long",
    config: "Configuration must be one of the named configurations in tests/golden/configurations.json, such as `en.casual`",
    text: "Text must be one block of 1-1000 characters",
    date: "Reference date must be a UTC ISO instant such as `2024-02-29T12:00:00.000Z`",
    timezone: "Reference timezone must be an abbreviation (e.g. `EST`) or minutes from UTC (e.g. `-300`)",
    optionsBlock: "Options must be one JSON block",
    optionsJson: "Options must be JSON",
    options: 'Options may only be `{}` or `{"forwardDate": true}`',
};

/**
 * A bug report (the form, or the monitor's issue) as a request. Everything in an issue is data,
 * so anything unexpected is rejected with a reason, never guessed.
 * @returns {{request?: object, error?: string}}
 */
function parseReport(body) {
    if (typeof body !== "string" || body.length > 60000) return { error: ERRORS.body };
    const config = section(body, "Configuration");
    if (!config || !CONFIG_RE.test(config)) return { error: ERRORS.config };
    const text = unfence(section(body, "Text"));
    if (typeof text !== "string" || text.length === 0 || text.length > 1000) return { error: ERRORS.text };
    const instant = section(body, "Reference date");
    if (!instant || !INSTANT_RE.test(instant) || Number.isNaN(Date.parse(instant))) {
        return { error: ERRORS.date };
    }
    const tzRaw = section(body, "Reference timezone");
    let tz = null;
    if (tzRaw !== null) {
        if (/^[A-Z]{1,5}$/.test(tzRaw)) tz = tzRaw;
        else if (/^-?\d{1,3}$/.test(tzRaw) && Math.abs(Number(tzRaw)) <= 840) tz = Number(tzRaw);
        else return { error: ERRORS.timezone };
    }
    const optRaw = unfence(section(body, "Options"));
    let options = {};
    if (optRaw === undefined) return { error: ERRORS.optionsBlock };
    if (optRaw !== null) {
        try {
            options = JSON.parse(optRaw);
        } catch {
            return { error: ERRORS.optionsJson };
        }
        const keys = options && typeof options === "object" && !Array.isArray(options) ? Object.keys(options) : null;
        if (!keys || keys.some((k) => k !== "forwardDate") || (keys.length === 1 && typeof options.forwardDate !== "boolean")) {
            return { error: ERRORS.options };
        }
    }
    const iso = new Date(instant).toISOString();
    const reference = tz === null ? { kind: "date", instant: iso, timezone_input: null } : { kind: "object", instant: iso, timezone_input: tz };
    return { request: { id: 0, ...canonicalRequest({ text, config, reference, options }), system_timezone: "UTC" } };
}

/** What the intake does with one triaged request (an entry of compare.js --requests --report). */
function decide(outcome) {
    // chrono-node finds nothing but Rust does: no upstream step to blame, so a person locates it.
    if (outcome && outcome.status === "mismatched" && outcome.requires && outcome.requires.parsers.length + outcome.requires.refiners.length === 0) {
        return { action: "report", reason: "no_upstream_result" };
    }
    if (outcome && outcome.status === "mismatched") return { action: "propose", reason: "mismatch" };
    if (outcome && outcome.status === "matched") return { action: "report", reason: "same_as_chrono_node" };
    if (outcome && outcome.status === "not_comparable") return { action: "report", reason: "not_yet_ported" };
    return { action: "report", reason: "error" };
}

const HEAD = "**Factory intake** (plain code, no AI)";

/** Fixed comment texts. Nothing from the issue is echoed back except validated step names. */
function reportComment(reason, detail) {
    if (reason === "same_as_chrono_node") {
        return `${HEAD} · not a port bug\n\nThe pinned chrono-node gives exactly the same result as the Rust port for this request, so the port is faithful. If chrono-node itself is wrong, that is the owner's call (and an upstream report: https://github.com/wanasit/chrono/issues). Labelled \`needs-human\`; nothing is changed automatically.`;
    }
    if (reason === "not_yet_ported") {
        const steps = ((detail && detail.missing) || []).filter((s) => /^[A-Za-z0-9]+$/.test(s));
        return `${HEAD} · not ported yet\n\nchrono-node uses steps the Rust port doesn't have yet: ${steps.map((s) => `\`${s}\``).join(", ")}. They're on the port's backlog; this case is compared once they land. Closing.`;
    }
    if (reason === "invalid") {
        return `${HEAD} · can't triage\n\nThe report doesn't follow the bug report form: ${detail}. Edit it, then remove and re-add the \`factory:bug\` label.`;
    }
    if (reason === "proposed") {
        return `${HEAD} · port bug confirmed\n\nThe Rust port and the pinned chrono-node disagree on this request. Proposed fix task \`${detail.fix}\` (contract + golden case, owner review): #${detail.pr}. When it merges, the task issue is created and linked here.`;
    }
    if (reason === "no_upstream_result") {
        return `${HEAD} · port bug, needs a person\n\nchrono-node finds no date here but the Rust port does, so no upstream step can be blamed and the fix can't be scoped automatically. Labelled \`needs-human\`.`;
    }
    if (reason === "duplicate") {
        return `${HEAD} · already tracked\n\nThis request is already fix task \`${detail.fix}\`${detail.where ? ` (${detail.where})` : ""}.`;
    }
    return `${HEAD} · triage failed\n\nThe request couldn't be run through both implementations. A person needs to look.`;
}

const REASONS = new Set(["invalid", "same_as_chrono_node", "not_yet_ported", "duplicate", "error", "no_upstream_result"]);

/**
 * A decision read back from the triage job's artifact, reduced to what the comment step may use.
 * Throws on anything that isn't exactly what intake.js writes.
 */
function checkDecision(d) {
    const fail = () => {
        throw new Error("decision.json isn't a valid intake decision");
    };
    if (!d || typeof d !== "object") fail();
    if (d.action === "ignore") return { action: "ignore" };
    if (d.action === "propose") {
        if (typeof d.fix !== "string" || !/^[a-z]{2}\/fix-[0-9a-f]{8}$/.test(d.fix)) fail();
        return { action: "propose", fix: d.fix };
    }
    if (d.action !== "report" || !REASONS.has(d.reason)) fail();
    if (d.reason === "invalid") return Object.values(ERRORS).includes(d.detail) ? { action: "report", reason: "invalid", detail: d.detail } : fail();
    if (d.reason === "not_yet_ported") {
        const missing = d.detail && Array.isArray(d.detail.missing) ? d.detail.missing.filter((s) => typeof s === "string" && /^[A-Za-z0-9]{1,80}$/.test(s)).slice(0, 20) : [];
        return { action: "report", reason: d.reason, detail: { missing } };
    }
    if (d.reason === "duplicate") {
        const fix = d.detail && d.detail.fix;
        const where = d.detail && d.detail.where;
        if (typeof fix !== "string" || !/^[a-z]{2}\/fix-[0-9a-f]{8}$/.test(fix) || !["on main", "fix PR open"].includes(where)) fail();
        return { action: "report", reason: d.reason, detail: { fix, where } };
    }
    return { action: "report", reason: d.reason, detail: null };
}

module.exports = {
    FACTORY_BOT,
    ERRORS,
    checkDecision,
    sha256,
    MONITOR_MARKER,
    MONITOR_MARKER_RE,
    signature,
    canonicalRequest,
    fixId,
    groupMismatches,
    renderMonitorIssue,
    updateLastSeen,
    section,
    unfence,
    parseReport,
    decide,
    reportComment,
};
