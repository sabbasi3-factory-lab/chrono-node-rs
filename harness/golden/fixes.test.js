"use strict";
// Fix cases (DESIGN §6 "nightly monitor" → intake): requests where the Rust port and chrono-node
// disagreed, replayed through the real chrono-node so setup.js records them like any upstream
// test call. One jest test per file in harness/golden/fixes/, named after its fix id; generate.js
// writes each to tests/golden/fixes/<lang>-fix-<hash>.json with `requires.fix`.
// The inputs come from the intake (harness/feedback/intake.js) in a human-tier PR.
const fs = require("fs");
const path = require("path");

const UPSTREAM = path.resolve(__dirname, "../../upstream");
const FIXES = path.join(__dirname, "fixes");
const { Chrono } = require(path.join(UPSTREAM, "src/chrono"));

/** The named configuration, built exactly like setup.js's KNOWN_CONFIGS (anything else is skipped there). */
function configuration(name) {
    const [lang, ...rest] = name.split(".");
    const L = require(path.join(UPSTREAM, "src/locales", lang));
    if (lang === "en") {
        const gb = rest[0] === "GB";
        const strict = rest[rest.length - 1] === "strict";
        return new Chrono(strict ? L.configuration.createConfiguration(true, gb) : L.configuration.createCasualConfiguration(gb));
    }
    return new Chrono(rest[0] === "strict" ? L.createConfiguration(true) : L.createCasualConfiguration());
}

function reference(ref) {
    if (ref.kind === "none") return undefined;
    const instant = new Date(ref.instant);
    if (ref.kind === "date") return instant;
    return { instant, timezone: ref.timezone_input ?? undefined };
}

const files = fs.existsSync(FIXES) ? fs.readdirSync(FIXES).filter((f) => f.endsWith(".json")).sort() : [];
if (files.length === 0) test("no fix cases", () => {});
for (const f of files) {
    const fix = JSON.parse(fs.readFileSync(path.join(FIXES, f), "utf8"));
    if (`${fix.id.replace("/", "-")}.json` !== f) throw new Error(`${f}: id ${fix.id} doesn't match the file name`);
    test(fix.id, () => {
        const r = fix.request;
        configuration(r.config).parse(r.text, reference(r.reference), { ...r.options });
    });
}
