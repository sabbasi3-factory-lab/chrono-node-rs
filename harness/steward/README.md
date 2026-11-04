# steward: the dependency steward

Plain code, no AI. Agents can't edit `Cargo.toml` (`tiers.yaml` `protected_from_agents`). An agent that needs a crate files a `dependency-request` issue, and so can a person with write access (`.github/ISSUE_TEMPLATE/dependency-request.yml`). The steward checks the request against the pinned factory `policies/dependencies.yaml`, and the policy decides. The steward is DESIGN §9 "Dependency steward".

**Tier:** human (under `harness/`). Agents can't edit it.

## Flow (`.github/workflows/dependency-steward.yml`)

1. **authorize:** the `dependency-request` label was added by the agent App, the controller App, or someone with write access. An approval (`dependency:approved` on a borderline request) must come from someone with write access, never from an App. GitHub's permission API needs a token with push access, so this job runs only checkout and `steward.js authorize`.
2. **check** (read-only token): `steward.js check` in a checkout of `main`. It runs `cargo add`, `cargo metadata` and `cargo deny`, none of which run crate code.
   - **Parse:** the headings `### Crate`, `### Version` (`1`, `1.2` or `1.2.3`), `### Kind` (`runtime` or `dev`), `### Reason`, and optionally `### Task`. Anything else gets a fixed "can't check" comment.
   - **Already a dependency** of that kind → closed.
   - **Before resolving:** the denylist and the typosquat check. A near miss is an edit distance of 1 (2 for names of 8+ characters), or the same letters with `_`/`-` moved, compared against the 200 most-downloaded crates on crates.io, the preapproved list and the denylist. The crate itself isn't a near miss of itself; crates.io treats `-` and `_` as the same.
   - **Hard checks** (any failure → `dependency:rejected`, closed):
     - the denylist (also for transitive crates)
     - the SPDX licence of every new crate against `licence_allowlist` (OR/AND/parentheses; `X WITH Y` only if listed exactly)
     - the resolved version isn't yanked
     - `cargo deny` with the repo's `deny.toml`: RustSec advisories (including yanked), bans, sources, licences
     - no network use in any new build script: HTTP client crates as build dependencies, sockets or HTTP clients in the build script's code (comments aren't counted), or running `curl`/`wget`/`git clone`/`fetch`
   - **Soft checks** (any failure, with every hard check passing → borderline):
     - crate age at least `min_crate_age_days`
     - at least `min_downloads`
     - a release within `max_months_since_release`
     - at most `max_new_transitive` new transitive crates
     - no native code (`links`, or `cc`/`cmake`/`bindgen`/`pkg-config` build dependencies)
     - adding the crate doesn't move any locked version
   - **Waivers:**
     - `preapproved` (by kind; `wasm` counts as runtime) waives every soft check except moved locked versions
     - a full `cargo vet` audit of that exact version from a `trusted_audits` source waives the crate's own trust signals: age, downloads, recency and native code. It must meet `safe-to-deploy` (dev: or `safe-to-run`). The sources are mozilla, google and bytecode-alliance.
     - an `exceptions` entry (crate, version prefix, kind) waives exactly what it lists
3. **apply** (controller App; live only):
   - **pass:** re-resolves exactly the checked version with `cargo add <name>@<version>`. It requires `Cargo.toml` to gain exactly one line, `Cargo.lock` to only add lines, and the added packages to be exactly the ones checked. Then it opens a PR on `factory/deps/<name>-<version>` and labels the issue `dependency:pr-open`.
   - **borderline:** `dependency:borderline` and `needs-human`, plus a comment listing the failed soft checks.
   - **fail:** a comment listing the failed hard checks; closed.
   Comments are fixed templates. The decision is re-validated, because it comes from a job that resolved third-party crates.
4. **sweep** (hourly): a borderline request still without `dependency:approved` 24 hours after it was labelled borderline is rejected (`limits.yaml` `borderline_dependency.auto_reject_after_hours`). An approval re-runs the check with the soft failures accepted. Hard failures are never accepted.
5. **enqueue** (after `ci`/`gates` complete): a steward PR is auto-strict because `Cargo.toml` is in that tier, so CI runs the strict gates. The steward queues the PR once every one of these holds on the current head: the PR was opened by the controller App, it's on a `factory/deps/*` branch, it changes exactly `Cargo.toml` and `Cargo.lock`, `ci` and `gates` succeeded, and the full-regression step succeeded. The queue then merges it. Agents get the crate from the next run: `cargo vendor` and the offline docs in their setup steps pick it up.

Kill switch: unless `FACTORY_ENABLED` is exactly `true`, nothing is written.

## Agents

`implement` and `repair` have a `create-issue` safe output: at most 1 per run, with the label `dependency-request` and the title prefix `[dependency-request] `. Their prompts give the headings above. gh-aw v1.0.1 adds the label but doesn't restrict any other labels the agent adds. Those are inert: every consumer checks who labelled the issue, and gh-aw strips HTML comments, so a request can't carry a task or monitor marker.

## Drill (local, with the pinned policy and live crates.io)

| Request | Verdict |
|---|---|
| `dateparser 0.2` (denylisted) | fail: `denylist` |
| `two-timer 2` (denylisted, doesn't resolve) | fail: `denylist` (checked before resolving) |
| `serde_jsn 1`, `rgex 1` | fail: `typosquat:serde_json`, `typosquat:regex` |
| `fibre_stats 0.9`, `async-support 0.0` | fail: licence outside the allowlist / unlicensed (`cargo_deny:rejected`/`unlicensed`) |
| `ukit-mem 0.1` (days old, 0 downloads) | borderline: `min_crate_age_days`, `min_downloads` |
| the same, with `dependency:approved` | pass (soft failures accepted) |
| `once_cell 1`, `smallvec 1` | pass |
| `chrono 0.4` (preapproved) | pass; `max_new_transitive` and `native_code` waived (preapproved) |
| `proptest 1` (dev, preapproved) | pass; `max_new_transitive` waived |
| `serde_json 1` | already a dependency |

To reproduce one: write an issue event JSON with the request body (see `test/lib.test.js` for the format), run `node steward/steward.js check --event e.json --out out` in `harness/`, then `git checkout Cargo.toml Cargo.lock`.

## Tests

`npm run test:gates` (in `harness/`) runs `steward/test/` with the gate tests.
