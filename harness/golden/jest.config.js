"use strict";
// Jest config that runs chrono-node's own tests from upstream/ (unmodified) with the recording
// setup in setup.js. Core (root) and the ported locales' test files.
const path = require("path");

const upstream = path.resolve(__dirname, "../../upstream");
// Generated locales (lib/locales.js): their upstream test directory; performance tests skipped.
const generated = require("../lib/locales").generatedLocales();

module.exports = {
    rootDir: upstream,
    roots: ["<rootDir>/test", __dirname],
    testMatch: [
        "<rootDir>/test/*.test.ts",
        "<rootDir>/test/en/*.test.ts",
        "<rootDir>/test/de/*.test.ts",
        "<rootDir>/test/fr/*.test.ts",
        "<rootDir>/test/sv/*.test.ts",
        "<rootDir>/test/pt/*.test.ts",
        "<rootDir>/test/es/*.test.ts",
        "<rootDir>/test/ja/*.test.ts",
        ...generated.map((l) => `<rootDir>/${l.tests}/*.test.ts`),
        // Fix cases from the intake (harness/golden/fixes/), replayed through chrono-node.
        path.join(__dirname, "fixes.test.js"),
        // Coverage cases of generated locales (harness/golden/coverage/, from the onboarding generator).
        path.join(__dirname, "coverage.test.js"),
    ],
    // Performance tests only time big inputs; they add nothing to golden data.
    testPathIgnorePatterns: ["/node_modules/", "en_performance\\.test\\.ts$", ...generated.map((l) => `/${l.tests}/[a-z_]+_performance\\.test\\.ts$`)],
    transform: {
        "^.+\\.ts$": [
            require.resolve("ts-jest"),
            { tsconfig: path.join(upstream, "tsconfig.json"), diagnostics: false },
        ],
    },
    setupFilesAfterEnv: [path.join(__dirname, "setup.js")],
    cacheDirectory: path.resolve(__dirname, "../.jest-cache"),
    testEnvironment: "node",
};
