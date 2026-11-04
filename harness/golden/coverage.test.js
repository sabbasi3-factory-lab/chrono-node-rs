"use strict";
// Coverage cases for generated locales (harness/onboard/onboard.js): requests chosen by the
// generator because no upstream test exercises one of the locale's steps. Replayed through the
// real chrono-node so setup.js records them like any upstream test call; generate.js writes them to
// tests/golden/<module>/coverage.json. The requests come from the onboarding generator, never by
// hand, and the expected results are chrono-node's, like every other golden case.
const fs = require("fs");
const path = require("path");

const UPSTREAM = path.resolve(__dirname, "../../upstream");
const COVERAGE = path.join(__dirname, "coverage");
const LOCALES = require("../lib/locales");

function reference(ref) {
    if (ref.kind === "none") return undefined;
    const instant = new Date(ref.instant);
    if (ref.kind === "date") return instant;
    return { instant, timezone: ref.timezone_input ?? undefined };
}

const locales = new Map(LOCALES.generatedLocales().map((l) => [l.module, l]));
const files = fs.existsSync(COVERAGE) ? fs.readdirSync(COVERAGE).filter((f) => f.endsWith(".json")).sort() : [];
if (files.length === 0) test("no coverage cases", () => {});
for (const f of files) {
    const input = JSON.parse(fs.readFileSync(path.join(COVERAGE, f), "utf8"));
    const locale = locales.get(input.module);
    if (!locale || `${input.module}.json` !== f) throw new Error(`${f}: not a generated locale's coverage input`);
    const L = require(path.join(UPSTREAM, "src", locale.upstream));
    for (const [i, r] of input.requests.entries()) {
        const exported = locale.configs[r.config];
        if (!exported) throw new Error(`${f}: ${r.config} is not a configuration of ${input.module}`);
        test(`${input.module}/coverage#${i + 1} ${r.step}`, () => {
            L[exported].parse(r.text, reference(r.reference), { ...r.options });
        });
    }
}
