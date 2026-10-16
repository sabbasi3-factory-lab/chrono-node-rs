"use strict";
// Jest config that runs chrono-node's own tests from upstream/ (unmodified) with the recording
// setup in setup.js. Only core (root) and English test files: Stage 0 scope is core + English.
const path = require("path");

const upstream = path.resolve(__dirname, "../../upstream");

module.exports = {
    rootDir: upstream,
    roots: ["<rootDir>/test"],
    testMatch: ["<rootDir>/test/*.test.ts", "<rootDir>/test/en/*.test.ts"],
    // Performance tests only time big inputs; they add nothing to golden data.
    testPathIgnorePatterns: ["/node_modules/", "en_performance\\.test\\.ts$"],
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
