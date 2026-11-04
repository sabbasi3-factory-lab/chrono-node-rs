# feedback: nightly monitor and bug intake

Plain code, no AI. Closes the loop after merge: nothing else tells the factory it shipped something wrong.

**Tier:** human (under `harness/`). Agents can't edit it.

```text
monitor.yml (nightly)            intake.yml (issues)                          intake.yml (push to main)
compare.js, fresh seed  ──►  factory:bug issue  ──►  re-run the request  ──►  fix PR (human tier)  ──►  task issue  ──►  controller
                           (one per signature)      Rust vs chrono-node     contract + golden case     (seed.js)         (as any task)
```

## Monitor (`monitor.js`, `.github/workflows/monitor.yml`)

- **What runs:** `compare/compare.js` on `main`, 20,000 phrases per language, with a **fresh random seed** (CI's held-out idea, at scale). Every language `compare/phrases.js` generates is covered, so a newly ported language joins the monitor when it joins the harness.
- **Recorded:** the seed is the run's last log line and is in every issue, with the per-language phrase count, so `node compare/compare.js --seed <seed> --phrases <n>` reproduces the run. Each issue also carries its single request as one JSON line for `--requests`.
- **Dedupe:** one issue per **signature** = configuration + the steps chrono-node used (a hash, in a hidden `<!-- factory-monitor: … -->` marker). An open issue **created by the controller App** with the marker (the bug report, or the fix task it became) means the signature is known (a marker copied into anyone else's issue doesn't count): the monitor's own report gets its `Last seen` line updated, a task issue is left alone.
- **Minimal repro:** of the phrases sharing a signature, the shortest.
- **Cap:** at most 3 new issues per run; the rest are listed in the run summary.
- **Labels:** `monitor` + `factory:bug`.
- **Errors** (a request one side couldn't run) aren't filed; the run fails, which is the alert. So does a comparison that fails with nothing to file (e.g. it checked nothing meaningful).
- **Identity:** the controller App, `issues: write` only, minted after every build step.
- **Kill switch:** unless `FACTORY_ENABLED` is exactly `true`, it prints the issues it would open.

## Intake (`intake.js`, `.github/workflows/intake.yml`)

A bug report is a request that can be re-run, so triage is deterministic.

1. **Trigger:** the `factory:bug` label being added (also when an issue is created with it), by the monitor (controller App) or by someone with write access. Others are ignored (a maintainer can re-add the label after checking the report). `opened` isn't a trigger: it would triage every report twice.
2. **Parse:** the form's headings (`.github/ISSUE_TEMPLATE/port-bug.yml`; the monitor writes the same ones). Every field is validated (the configuration must be one in `tests/golden/configurations.json`); anything unexpected gets a fixed "can't triage" comment.
3. **Re-run:** `compare.js --requests` on `main`'s Rust CLI and the pinned chrono-node.
4. **Decide:**

   | Result | Action |
   |---|---|
   | They disagree | Port bug: a human-tier PR (controller App, branch `factory/intake/<lang>-fix-<hash>`) adds `harness/golden/fixes/<id>.json` (the request), the generated `tests/golden/fixes/<id>.json` (chrono-node's output) and the generated `contracts/<lang>/fix-<hash>.yaml`. The issue gets `intake:proposed` and a link. |
   | They agree | `intake:not-a-port-bug` + `needs-human`, left open: the port is faithful, and a claim that chrono-node itself is wrong is always the owner's call. |
   | Steps not ported | `intake:not-ported-yet`, closed. |
   | Already proposed or on `main` | A comment pointing at it. |
   | Rust finds a date, chrono-node finds none | `needs-human`: no upstream step to blame, so the fix can't be scoped automatically. |
   | Couldn't run | `needs-human`. |

5. **After the PR merges** (`link` job, push to `harness/golden/fixes/**`): `seed.js issues --plan --only <new fix ids>` plans the task issue (with the monitor marker) before any token exists; `intake.js tasks` creates it, and `intake.js link` closes the bug report with a link to it. The controller takes the task like any other (auto-ready for the `auto` tier).

Comments are fixed templates; no issue text is echoed back. Writes happen only in live mode. While the App token exists only `intake.js` runs (Node built-ins and this directory, no packages), and it re-validates what it reads from the triage job: the decision against the known reasons and messages, and exactly the three expected files for a PR.

## Fix tasks

- **Id:** `<lang>/fix-<first 8 hex of sha256(the canonical request)>`, so the same request always maps to the same task.
- **Contract** (`scripts/seed-backlog`, `buildFixContracts`): scope = the Rust files of every step chrono-node used for the case (finding the diverging one is the fix); area = the first of those steps' task areas, else `<lang>-fixes`; tier from `policies/tiers.yaml`; priority 0; golden step = the fix id; a `fix.requirement` the agent follows.
- **Golden case:** `tests/golden/fixes/<lang>-fix-<hash>.json`, with `requires.fix: <id>`. The Rust golden runner treats the fix id as a step that is ported once a `// factory-fix: <id>` comment exists under `src/`. So:
  - before the fix the case is **pending** (a known bug doesn't fail every PR);
  - the fix PR must add the marker, and the contract's golden gate (`GOLDEN_REQUIRE_STEP=<id>`) then requires the case to pass;
  - after the merge it's **checked on every PR**, so the bug can't come back silently.

## Drills

- **Monitor, live:** run `monitor` by hand with `drill: true`. `compare.js --plant` drops the Rust results of one comparable phrase; the monitor files one `[drill]` issue labelled `monitor` + `drill` (not `factory:bug`, so the intake ignores it) and closes it at once.
- **Whole loop, local:** break a step (e.g. `tonight` → hour 21 in `src/locales/en/parsers/casual_date.rs`), build the CLI to a scratch path, then `compare.js --rust <scratch> --report r.json`, `monitor.js --report r.json --phrases N` (dry-run), feed one rendered issue to `intake.js input` and `decide`, then `npm run golden` and `seed.js contracts`. The fix case is pending in `cargo test --test golden`; the contract's `GOLDEN_AREAS`/`GOLDEN_REQUIRE_STEP` run fails until the marker exists; with the marker it fails on the broken code and passes on the fixed code.

## Tests

`npm run test:gates` (in `harness/`) runs `feedback/test/` with the gate tests; `scripts/seed-backlog` has `npm test`.
