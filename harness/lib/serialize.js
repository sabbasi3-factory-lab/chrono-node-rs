"use strict";
// Shared serialization of chrono-node inputs and outputs.
// Used by the golden-test generator and the comparison harness, so both record the same shape.
// The Rust side (src/bin/chrono-rs-json.rs) emits exactly this shape too.

/** Recursively sort object keys so JSON output is stable. */
function sortKeys(value) {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value && typeof value === "object" && !(value instanceof Date)) {
        const out = {};
        for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
        return out;
    }
    return value;
}

function isoOrNull(date) {
    if (!(date instanceof Date)) return null;
    const t = date.getTime();
    return Number.isFinite(t) ? date.toISOString() : null;
}

/** One ParsingComponents (start or end). Private fields are read directly; this is JS. */
function serializeComponents(components) {
    if (!components) return null;
    return {
        known: sortKeys({ ...components.knownValues }),
        implied: sortKeys({ ...components.impliedValues }),
        date: isoOrNull(components.date()),
        tags: Array.from(components.tags()).sort(),
    };
}

/**
 * One ParsingResult. `index` is in UTF-16 code units, as JavaScript counts it.
 * Rust must convert its byte offsets before comparing.
 */
function serializeResult(result) {
    return {
        index: result.index,
        text: result.text,
        start: serializeComponents(result.start),
        end: serializeComponents(result.end),
    };
}

function serializeResults(results) {
    return results.map(serializeResult);
}

/**
 * The reference exactly as the caller passed it, plus what chrono resolved it to.
 * kind: "none" (no reference: chrono uses "now"), "date" (a Date), "object" (a ParsingReference).
 */
function serializeReference(input, resolved) {
    let kind = "none";
    let timezoneInput = null;
    if (input instanceof Date) {
        kind = "date";
    } else if (input && typeof input === "object") {
        kind = "object";
        timezoneInput = input.timezone ?? null;
    }
    return {
        kind,
        instant: isoOrNull(resolved.instant),
        timezone_input: timezoneInput,
        timezone_offset: resolved.timezoneOffset ?? null,
    };
}

/**
 * Parsing options without the debug handler. Returns null if the options can't be represented
 * as plain JSON (for example a custom timezone map with functions); such cases are skipped.
 */
function serializeOptions(option) {
    if (!option) return {};
    const { debug, ...rest } = option;
    const json = JSON.stringify(rest);
    if (json === undefined) return null;
    const copy = JSON.parse(json);
    if (!deepEqualPlain(copy, rest)) return null;
    return sortKeys(copy);
}

function deepEqualPlain(a, b) {
    if (typeof b === "function") return false;
    if (a === b) return true;
    if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
    if (b instanceof Date) return false;
    const ka = Object.keys(a);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    if (ka.length !== kb.length) return false;
    return kb.every((k) => deepEqualPlain(a[k], b[k]));
}

/**
 * Class name plus boolean constructor flags (strictMode, littleEndian, ...), for parsers or refiners.
 * Only booleans: other own fields are lazily built pattern caches that change after first use.
 */
function describeStep(step) {
    const flags = {};
    for (const key of Object.keys(step)) {
        if (typeof step[key] === "boolean") flags[key] = step[key];
    }
    return { name: step.constructor.name, flags: sortKeys(flags) };
}

function describeConfiguration(chrono) {
    return {
        parsers: chrono.parsers.map(describeStep),
        refiners: chrono.refiners.map(describeStep),
    };
}

module.exports = {
    sortKeys,
    serializeComponents,
    serializeResult,
    serializeResults,
    serializeReference,
    serializeOptions,
    describeConfiguration,
};
