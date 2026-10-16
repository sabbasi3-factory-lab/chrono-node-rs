# harness

Node tools that run the **real chrono-node** from `upstream/` as the judge for the Rust port.

**Tier:** human. Agents can't edit this directory.

| Tool | Command | What it does |
|---|---|---|
| Golden-test generator | `npm run golden` / `npm run golden:check` | Records chrono-node's outputs for its own core and English test cases into `tests/golden/`. See `tests/golden/README.md`. |

Setup: Node 24 or later, then `npm ci` in this directory. Dependency versions are pinned exactly and match `upstream/package-lock.json`.

`lib/serialize.js` defines the JSON shape of inputs and results. The golden generator, the comparison harness and the Rust JSON CLI all use the same shape.
