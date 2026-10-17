# harness

Node tools that run the **real chrono-node** from `upstream/` as the judge for the Rust port.

**Tier:** human. Agents can't edit this directory.

| Tool | Command | What it does |
|---|---|---|
| Golden-test generator | `npm run golden` / `npm run golden:check` | Records chrono-node's outputs for its own core and English test cases into `tests/golden/`. See `tests/golden/README.md`. |
| Comparison harness | `npm run build:upstream`, then `npm run compare -- [--seed N] [--phrases N] [--rust PATH] [--report FILE]` | Generates seeded random phrases and random reference dates, runs them through chrono-node and the Rust `chrono-rs-json` CLI, and compares the outputs. See below. |

Setup: Node 24 or later, then `npm ci` in this directory. Dependency versions are pinned exactly and match `upstream/package-lock.json`.

`lib/serialize.js` defines the JSON shape of inputs and results. The golden generator, the comparison harness and the Rust JSON CLI all use the same shape.

## Comparison harness

- **Phrases** (`compare/phrases.js`): a seeded PRNG (mulberry32) mixes English date and time expressions with filler text, punctuation, case changes and some non-ASCII text (`café`, `😀`, NBSP), so byte and UTF-16 indexes differ.
- **Reference dates** come from the same seed. They're random in 2000–2040, biased towards Feb 28/29, month ends, Dec 31 and Jan 1, and some carry a time zone (abbreviation or minutes). Each request carries its reference and time zone explicitly.
- **What gets compared:** chrono-node runs each phrase step by step (`lib/trace.js`) to find the parsers and refiners it needs. A phrase is compared only if Rust has all of them (`chrono-rs-json --registered`). The rest count as `not_yet_comparable`, a number that shrinks as the port grows.
- **Exit code** is 1 on any mismatch or error, or if no comparable phrase has a non-empty result (so the check can never pass vacuously). Bad arguments exit 2. The summary line reports `comparable`, `matched`, `matched_with_results` and `mismatched`.
- **Held-out seed:** without `--seed`, a fresh seed comes from `crypto.randomInt`. It's printed **after** the run, as the last line, even if the run crashes:
  ```text
  factory-heldout-seed: 1234567890
  ```
  With `--seed` (the contract's visible seed, or a reproduction) the line is `factory-comparison-seed: <n>` instead.
- **Held-out seed in CI (commit–reveal):** CI uses a fresh seed on every run, but it doesn't come from this script. The `checks` job's first step, which runs before any PR code, draws a seed and a salt, writes them to private files and prints only `factory-heldout-commit: <sha256("<salt>:<seed>")>`. The held-out comparison reads the seed into a shell variable (never a step header or exported variable) and runs with `--seed <that seed>`. After the run, a final step reveals `factory-heldout-seed: <n>` and `factory-heldout-salt: <hex>`. The controller records the seed in the audit log only if the reveal matches the single commitment from the first step and the change leaves `.github/` alone, so PR code can't forge the recorded seed. That proves which seed was generated, not that the comparison used it honestly; a factory PR without a trusted seed goes to a human. Seeds aren't stored anywhere else.
- **Reproduce** a failure with `node compare/compare.js --seed <seed> --phrases <n>`.
