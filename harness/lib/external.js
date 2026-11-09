"use strict";
// External locales (factory policies/onboarding.yaml `external_locales`, owner 2026-11-09: vi): generated
// on main (oracle, golden cases, code; CI checks them), but never factory-run: no onboarding decision,
// no task issues, no controller dispatch, and left out of the onboarding stop rules and in-flight count.
//
// Built-ins only: issues.js runs this with a write token. The key is read strictly from its one line
// (`external_locales: [a, b]`, flow style); anything else (missing file, a block list, a second
// occurrence, a bad code) is an error, so a policy that can't be read creates no issues (fail closed).
const fs = require("fs");

const CODE = "[a-z]{2}(?:-[a-z]{4})?";
const LINE = new RegExp(`^external_locales:[ \\t]*\\[[ \\t]*((?:${CODE})(?:[ \\t]*,[ \\t]*${CODE})*)?[ \\t]*\\][ \\t]*(?:#.*)?$`);

/** `external_locales` codes from the onboarding policy's text; [] when the key is absent. Throws on anything else. */
function parseExternal(text) {
    if (typeof text !== "string" || !/^version:[ \t]*1[ \t]*$/m.test(text)) throw new Error("onboarding policy: unreadable (no `version: 1`)");
    const lines = text.split("\n").filter((l) => /^external_locales\s*:/.test(l));
    if (lines.length === 0) return [];
    if (lines.length > 1) throw new Error("onboarding policy: external_locales appears twice");
    const m = LINE.exec(lines[0].replace(/\r$/, ""));
    if (!m) throw new Error("onboarding policy: external_locales must be a one-line list of locale codes, e.g. [vi]");
    return m[1] ? m[1].split(",").map((s) => s.trim()) : [];
}

/** parseExternal of a policy file; a missing or empty file throws. */
function readExternal(file) {
    if (!file || !fs.existsSync(file) || fs.statSync(file).size === 0) throw new Error(`onboarding policy ${file || "(none)"}: missing`);
    return parseExternal(fs.readFileSync(file, "utf8"));
}

module.exports = { parseExternal, readExternal };
