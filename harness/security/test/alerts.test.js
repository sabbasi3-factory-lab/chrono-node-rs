"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { classify, plan, MARKER } = require("../alerts");

const alert = (eco, manifest, ghsa = "GHSA-xxxx-2345-6789", over = {}) => ({
    state: "open",
    dependency: { package: { ecosystem: eco, name: "pkg" }, manifest_path: manifest },
    security_advisory: { ghsa_id: ghsa, severity: "high" },
    security_vulnerability: { vulnerable_version_range: "< 1.2.3", first_patched_version: { identifier: "1.2.3" } },
    ...over,
});

test("routes: cargo → steward, vendored upstream npm → upstream bump, other tooling → a person", () => {
    assert.strictEqual(classify(alert("cargo", "Cargo.lock")), "steward");
    assert.strictEqual(classify(alert("npm", "upstream/package-lock.json")), "upstream-bump");
    assert.strictEqual(classify(alert("npm", "harness/package-lock.json")), "human");
    assert.strictEqual(classify(alert("npm", "harness/package-lock.json", "GHSA-xxxx-2345-6789", { state: "dismissed" })), null);
});

test("plan: one issue per advisory and manifest, never twice, none for the vendored oracle", () => {
    const alerts = [alert("cargo", "Cargo.lock"), alert("cargo", "Cargo.lock"), alert("npm", "upstream/package-lock.json"), alert("npm", "harness/package-lock.json", "GHSA-wwww-2345-6789")];
    const p = plan(alerts, []);
    assert.deepStrictEqual(p.summary, { steward: 2, "upstream-bump": 1, human: 1 });
    assert.deepStrictEqual(p.issues.map((i) => i.title), ["[security] pkg (high): GHSA-xxxx-2345-6789", "[security] pkg (high): GHSA-wwww-2345-6789"]);
    assert.ok(p.issues[0].body.startsWith(MARKER("GHSA-xxxx-2345-6789", "Cargo.lock")));
    assert.match(p.issues[0].body, /dependency steward/);
    assert.deepStrictEqual(plan(alerts, [p.issues[0].body]).issues.length, 1);
});

test("plan: advisory text is data (malformed ids are skipped, free text is stripped)", () => {
    const bad = alert("cargo", "Cargo.lock", "GHSA-<script>");
    assert.deepStrictEqual(plan([bad], []).issues, []);
    const odd = alert("cargo", "Cargo.lock", "GHSA-xxxx-2345-6789", { dependency: { package: { ecosystem: "cargo", name: "a`b<!--x-->" }, manifest_path: "Cargo.lock" } });
    assert.ok(!plan([odd], [])[ "issues"][0].title.includes("`"));
});
