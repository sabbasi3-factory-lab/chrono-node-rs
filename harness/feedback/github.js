"use strict";
// Minimal GitHub REST client for the monitor and intake (fetch; no dependencies).
const REPO = process.env.GITHUB_REPOSITORY || "sabbasi3-factory-lab/chrono-node-rs";

async function gh(method, apiPath, body) {
    const token = process.env.GH_TOKEN;
    if (!token) throw new Error("GH_TOKEN is required");
    const res = await fetch(`https://api.github.com${apiPath}`, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404 && method === "GET") return null;
    if (!res.ok) throw new Error(`${method} ${apiPath}: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res.status === 204 ? null : res.json();
}

async function paginate(apiPath) {
    const out = [];
    for (let page = 1; ; page++) {
        const batch = await gh("GET", `${apiPath}${apiPath.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
        if (!Array.isArray(batch)) break;
        out.push(...batch);
        if (batch.length < 100) break;
    }
    return out;
}

/** Open issues (not PRs). */
const openIssues = async () => (await paginate(`/repos/${REPO}/issues?state=open`)).filter((i) => !i.pull_request);

module.exports = { REPO, gh, paginate, openIssues };
