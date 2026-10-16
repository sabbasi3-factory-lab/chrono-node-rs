"use strict";
// Re-runs a chrono-node parse step by step: which parsers produced results and which refiners
// changed them ("requires"). Shared idea with harness/golden/setup.js; see tests/golden/README.md.
const S = require("./serialize");

const snapshot = (results) => JSON.stringify(S.serializeResults(results));

/**
 * @param chronoModule the compiled upstream module exports (Chrono, ParsingContext)
 * @returns {{results, parsers: string[], refiners: string[]}}
 */
function trace(chronoModule, chrono, text, ref, option) {
    const { Chrono, ParsingContext } = chronoModule;
    const context = new ParsingContext(text, ref, option);
    const parsers = new Set();
    const refiners = new Set();
    let results = [];
    for (const parser of chrono.parsers) {
        const found = Chrono.executeParser(context, parser);
        if (found.length > 0) parsers.add(parser.constructor.name);
        results = results.concat(found);
    }
    results.sort((a, b) => a.index - b.index);
    for (const refiner of chrono.refiners) {
        const before = snapshot(results);
        results = refiner.refine(context, results);
        if (snapshot(results) !== before) refiners.add(refiner.constructor.name);
    }
    return { results, parsers: [...parsers].sort(), refiners: [...refiners].sort() };
}

module.exports = { trace };
