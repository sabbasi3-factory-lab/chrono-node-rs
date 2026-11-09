# Factory v2: one agent run per language, on platform features

v2 ports a whole language in **one agent run and one PR**, and lets GitHub run the flow: an event starts the run, a
failing check starts a repair, and auto-merge plus the merge queue merge the PR once the required checks pass. Custom
code covers only the spend caps, the stop rules and the audit hooks. v2 runs beside v1, limited to the languages in
[`.github/factory/v2.yaml`](../.github/factory/v2.yaml) (the pilot: `it`). Each of them must also be in factory
`policies/onboarding.yaml` `external_locales`, so v1 never works on it.

**Why.** v1's unit is one parser class, so each class pays the full cycle of about 13–15 minutes (gh-aw start-up,
threat detection, CI, review, merge queue). Dutch took 2.1 h and Ukrainian 5.7 h. A polling controller (about 540
tests) dispatches and merges, and GitHub throttles both its cron (every 2–8 h) and its App API quota. A goal-driven
agent ported Vietnamese in about 10 minutes of agent work with the same quality, but its PRs ran as a person, so the
test lock wasn't enforced. v2 aims for that speed with the lock.

## v1 → v2

| v1 component | v2 | Why |
|---|---|---|
| Unit of work: one class (contract) per run and PR | **Changed**: one language per run and PR; every contract in it is still checked in the PR | About 15–20× fewer cycles per language |
| Controller (`controller.yml`, TypeScript, polls every 5 min): admission, WIP, dispatch, merge, repair, audit | **Replaced** by `v2-router.yml` (plain Actions, events only) and platform features | No polling, no App quota |
| Controller enqueues green PRs | **Replaced** by auto-merge (gh-aw `create-pull-request: auto-merge`) and the merge queue | The required checks (`checks`, `gates`, CodeQL) already decide |
| Task issues, `factory:ready` and `factory:picked` | **Replaced** by one issue per language, opened by the router when the language's contracts land on main | Trigger and audit anchor |
| `implement.md` | **Kept, widened**: `v2-port.md`, same sandbox, App and safe outputs | Scope is the union of the language's contracts |
| `repair.md`, dispatched by the controller | **Kept, widened**: `v2-repair.md`, dispatched by the router when `ci` fails | Same rules: at most 2 repairs; the same failure twice → `needs-human` |
| `gates` (scope, contract SHA, protected paths) | **Kept, extended**: a `Factory-Unit:` trailer checks the union of the language's contracts | The test lock, enforced by a required check |
| `ci` contract golden step | **Kept, extended**: runs once per contract in the unit | Per-class checks stay inside the PR |
| Reviewer App and `factory-review` | **Kept where v1 needs it**: v2 refuses units with an auto-strict contract | v1 needs the reviewer only for auto-strict; `it` has none |
| Controller's daily and per-task spend accounting | **Replaced** by gh-aw `max-ai-credits` / `max-daily-ai-credits`, plus the router's budget gate over `gh aw logs` | Platform caps per run and per day; one small total check |
| Hash-chained `audit` branch | **Replaced** by gh-aw logs and Outcomes (`outcomes.yml` covers v2), the run history and the router's issue comments | Platform features; no custom chain for v2 |
| Watchdog, heartbeat, rate-limit spacing, dispatch state | **Dropped** for v2 | They keep a polling controller alive |

## Guarantees and how v2 enforces them

- **Locked oracle.** Golden cases, contracts, `harness/`, `.github/`, `upstream/` and the generator are in factory
  `protected_from_agents`. `gates` (a required check, run from main's code) rejects an agent PR that touches them or
  anything outside the union of the language's contract scopes, and checks `Contract-SHA:` against the last commit to
  `contracts/<lang>/`. It runs again in the merge queue.
- **Sandboxed agent under the agent App.** `v2-port` and `v2-repair` are gh-aw workflows: read-only token, no network,
  safe outputs through the existing agent App, strict threat detection. `gates` sees the agent App as the author, so
  the agent-tier checks apply (the vi A/B run's gap).
- **Independent reviewer where v1 requires it.** Only auto-strict changes need `factory-review`. `v2-port` refuses a
  unit with an auto-strict contract, and `gates`' merge-queue review rule still applies to every agent PR.
- **Required CI and merge queue.** The `main` ruleset is unchanged (`checks`, `gates`, CodeQL, merge queue, squash).
- **Spend caps and budget.** Per run: `v2-port` 500 AIC, `v2-repair` 300, threat detection 400 (factory
  `budgets.yaml` `per_run`). Per day: `v2-port` 1000, `v2-repair` 600 (gh-aw `max-daily-ai-credits`). Total: the router
  starts a run only if the measured spend of all v2 runs (`gh aw logs`, every job's usage) plus the next run's agent cap
  fits `budget_aic` in `v2.yaml` (1000 for the pilot). A run still in progress counts at its caps.
- **Kill switch.** `FACTORY_ENABLED` must be `"true"` for the router to act and for `v2-port` and `v2-repair` to start.
- **Audit trail.** gh-aw logs and Outcomes for every agent run; the router comments each decision (start, repair,
  stop) and its reason on the language's issue.
- **Repair at most 2, then `needs-human`.** The router counts its repairs and compares failure signatures. A `gates`
  failure, a merge-queue removal or a spent budget goes straight to `needs-human`.

## Flow

1. A PR adding `contracts/<lang>/` (onboarding generator output) merges. The router (on `push` to main) opens the
   language's issue and dispatches `v2-port`.
2. `v2-port` ports every contract in dependency order, runs the checks offline and opens one PR with auto-merge on.
3. `ci` and `gates` run. A failure triggers the router (`workflow_run`), which dispatches `v2-repair` or stops.
4. When the required checks pass, GitHub queues and merges the PR, and the issue closes.

## What's measured, and the pilot plan

Measured: wall clock per stage (oracle merged → port PR opened → checks green → merged) and in total; agent runs,
repairs, CI failures, Copilot findings, AIC; human touches; custom lines of code, v2 vs v1. Compared with v1 (nl
2.1 h, uk 5.7 h, about 20–35 AIC per task) and the vi goal-agent run (1 h 19 min).

1. Merge this design, then the implementation.
2. Once main's factory pin lists `it` in `external_locales`, generate `it`'s oracle with the onboarding generator, in
   its own PR (generator output only).
3. Its merge starts v2. No person touches the run until it's merged.
4. Done when every `it` golden case passes, the frontier is complete and the 10,000-phrase comparison has no mismatch.
5. Report and recommend: migrate, keep v1, or a hybrid.

**Known limits.** One language per run is bounded by `v2-port`'s 500 AIC cap; if a language doesn't fit, the
fallback is one run per area (the contracts' `area` field). Auto-strict units stay on v1 until v2 dispatches the
reviewer. v2's budget is separate from v1's wave budget (`onboarding.yaml` `stop.budget_aic`), which counts only v1
runs; whether v2 spend should count towards it is an owner decision.
