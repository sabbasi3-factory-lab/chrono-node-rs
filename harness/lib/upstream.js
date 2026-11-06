"use strict";
// The pinned chrono-node (harness/.build/chrono) with every named configuration, as the golden
// generator records them. Shared by compare/compare.js and golden/frontier.js.
const fs = require("fs");
const path = require("path");
const S = require("./serialize");

const HARNESS = path.resolve(__dirname, "..");

/** {chronoCore, configs: {name: Chrono}} for the built upstream; throws if it isn't built. */
function loadUpstream() {
    const built = path.join(HARNESS, ".build/chrono/index.js");
    if (!fs.existsSync(built)) throw new Error("run `npm run build:upstream` in harness/ first");
    const chronoModule = require(built);
    const chronoCore = require(path.join(HARNESS, ".build/chrono/chrono.js"));
    const { Chrono, en, de, fr, sv, pt, es, ja } = chronoModule;
    S.registerUpstreamAliases((p) => require(path.join(HARNESS, ".build/chrono", p)));
    const configs = {
        "en.casual": new Chrono(en.configuration.createCasualConfiguration(false)),
        "en.strict": new Chrono(en.configuration.createConfiguration(true, false)),
        "en.GB.casual": new Chrono(en.configuration.createCasualConfiguration(true)),
        "en.GB.strict": new Chrono(en.configuration.createConfiguration(true, true)),
        "de.casual": new Chrono(de.createCasualConfiguration()),
        "de.strict": new Chrono(de.createConfiguration(true)),
        "fr.casual": new Chrono(fr.createCasualConfiguration()),
        "fr.strict": new Chrono(fr.createConfiguration(true)),
        "sv.casual": new Chrono(sv.createCasualConfiguration()),
        "sv.strict": new Chrono(sv.createConfiguration(true)),
        "pt.casual": new Chrono(pt.createCasualConfiguration()),
        "pt.strict": new Chrono(pt.createConfiguration(true)),
        "es.casual": new Chrono(es.createCasualConfiguration()),
        "es.strict": new Chrono(es.createConfiguration(true)),
        "ja.casual": new Chrono(ja.createCasualConfiguration()),
        "ja.strict": new Chrono(ja.createConfiguration(true)),
    };
    // Generated locales (lib/locales.js): the locale module's exported Chrono instances.
    for (const locale of require("./locales").generatedLocales()) {
        const L = require(path.join(HARNESS, ".build/chrono", locale.upstream));
        for (const [name, exported] of Object.entries(locale.configs)) {
            if (!(L[exported] instanceof Chrono)) throw new Error(`${locale.upstream} exports no Chrono ${exported}`);
            configs[name] = L[exported];
        }
    }
    return { chronoCore, configs };
}

/** A request's reference as chrono-node takes it (a Date, or a ParsingReference). */
function toUpstreamReference(reference) {
    const instant = new Date(reference.instant);
    if (reference.kind === "date") return instant;
    return { instant, timezone: reference.timezone_input ?? undefined };
}

module.exports = { loadUpstream, toUpstreamReference, HARNESS };
