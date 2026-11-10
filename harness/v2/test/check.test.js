"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { check } = require("../check");

function repo(rs) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "v2check-"));
    fs.mkdirSync(path.join(d, "contracts/it"), { recursive: true });
    fs.writeFileSync(
        path.join(d, "contracts/it/filter.yaml"),
        "id: it/filter\nscope:\n  - src/locales/it/refiners/filter.rs\nacceptance:\n  - unit:\n      requirement: r\n      cases:\n        - test: drops_it\n        - test: keeps_it\n"
    );
    fs.writeFileSync(path.join(d, "contracts/it/weekday.yaml"), "id: it/weekday\nscope:\n  - src/locales/it/parsers/weekday.rs\nacceptance:\n  - golden: {step: ITWeekdayParser, areas: [it/weekday]}\n");
    fs.mkdirSync(path.join(d, "src/locales/it/refiners"), { recursive: true });
    fs.mkdirSync(path.join(d, "src/locales/it/parsers"), { recursive: true });
    if (rs !== null) fs.writeFileSync(path.join(d, "src/locales/it/refiners/filter.rs"), rs);
    fs.writeFileSync(path.join(d, "src/locales/it/parsers/weekday.rs"), "// ported\n");
    return d;
}

test("names each missing unit test and scope file, as the gate does (#545)", () => {
    assert.deepStrictEqual(check("it", repo("#[cfg(test)]\nmod tests {\n    #[test]\n    fn drops_it() {}\n}\n")), ["it/filter: unit acceptance: no #[test] fn keeps_it in the changed scope files"]);
    assert.deepStrictEqual(check("it", repo(null)), ["it/filter: scope file src/locales/it/refiners/filter.rs is missing", "it/filter: unit acceptance: no #[test] fn drops_it in the changed scope files", "it/filter: unit acceptance: no #[test] fn keeps_it in the changed scope files"]);
    assert.deepStrictEqual(check("it", repo("#[test]\nfn drops_it() {}\n#[test]\nfn keeps_it() {}\n")), []);
    assert.match(check("../x")[0], /invalid language/);
});
