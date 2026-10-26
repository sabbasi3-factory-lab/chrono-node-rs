"use strict";
// Drill D8 as a test: the merge_group review gate end to end (GraphQL enqueuer + REST check runs,
// both stubbed), as scope-check.js runs it in the trusted gates job.
const test = require("node:test");
const assert = require("node:assert");
const { mergeGroupReview } = require("../scope-check");
const { REVIEWER_APP_ID } = require("../scope");

const HEAD = "c".repeat(40);
const PR = { number: 90, head: { sha: HEAD } };
const verdict = (o = {}) => ({ id: 5, app: { id: REVIEWER_APP_ID }, name: "factory-review", head_sha: HEAD, status: "completed", conclusion: "success", started_at: "2026-10-26T12:00:00Z", output: { summary: `Reviewed-Head: ${HEAD}` }, ...o });

/** Stubs fetch: the last AddedToMergeQueueEvent's actor, and the factory-review runs on HEAD. */
function world({ actor, runs, graphqlStatus = 200, checksStatus = 200 }) {
    const calls = [];
    global.fetch = async (url, init = {}) => {
        calls.push(url);
        if (url === "https://api.github.com/graphql") {
            const nodes = actor === undefined ? [] : [{ actor }];
            return { ok: graphqlStatus === 200, status: graphqlStatus, json: async () => ({ data: { repository: { pullRequest: { timelineItems: { nodes } } } } }) };
        }
        assert.strictEqual(url, `https://api.github.com/repos/o/r/commits/${HEAD}/check-runs?check_name=factory-review&filter=all&per_page=100`);
        return { ok: checksStatus === 200, status: checksStatus, json: async () => ({ check_runs: runs }) };
    };
    return calls;
}
const gate = (o) => mergeGroupReview({ repo: "o/r", pr: PR, isAgent: true, strict: true, ...o });

test("D8: a bot enqueues an agent auto-strict PR without a review → refused", async () => {
    for (const login of ["sabbasi3-factory-controller", "sabbasi3-factory-agent"]) {
        world({ actor: { __typename: "Bot", login }, runs: [] });
        const r = await gate();
        assert.strictEqual(r.ok, false, login);
        assert.match(r.why, /no factory-review from the reviewer App/);
    }
});

test("a bot enqueuer with the reviewer's pass on the head → allowed; another App's 'pass' → refused", async () => {
    world({ actor: { __typename: "Bot", login: "sabbasi3-factory-controller" }, runs: [verdict()] });
    assert.strictEqual((await gate()).ok, true);
    world({ actor: { __typename: "Bot", login: "sabbasi3-factory-controller" }, runs: [verdict({ app: { id: 5337825 } })] });
    assert.strictEqual((await gate()).ok, false);
});

test("a person enqueued → allowed without a verdict (the pre-promotion exemption)", async () => {
    const calls = world({ actor: { __typename: "User", login: "sabbasi3" }, runs: [] });
    assert.strictEqual((await gate()).ok, true);
    assert.ok(calls.length >= 1);
});

test("fails closed: no enqueue event, unreadable timeline or unreadable check runs", async () => {
    world({ actor: undefined, runs: [] });
    assert.strictEqual((await gate()).ok, false, "no enqueue event");
    world({ actor: { __typename: "User", login: "sabbasi3" }, runs: [verdict()], graphqlStatus: 502 });
    assert.strictEqual((await gate({})).ok, true, "timeline unreadable → not a person, but the verdict is there");
    world({ actor: { __typename: "User", login: "sabbasi3" }, runs: [], graphqlStatus: 502 });
    assert.strictEqual((await gate()).ok, false, "timeline unreadable and no verdict");
    world({ actor: { __typename: "Bot", login: "x" }, runs: [verdict()], checksStatus: 500 });
    assert.strictEqual((await gate()).ok, false, "check runs unreadable");
});

test("not required: nothing is read for a human PR or a non-strict change", async () => {
    const calls = world({ actor: { __typename: "Bot", login: "x" }, runs: [] });
    assert.strictEqual((await gate({ isAgent: false })).ok, true);
    assert.strictEqual((await gate({ strict: false })).ok, true);
    assert.deepStrictEqual(calls, []);
});
