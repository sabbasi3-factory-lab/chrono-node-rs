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
  starts a run only if the measured spend of all v2 runs (`gh aw logs`, every job's usage) plus every AI job of the
  next run at its cap (a port 500 + 400 + 500 for evals, a repair 300 + 400) fits `budget_aic` in `v2.yaml`: 2800, one
  port and two repairs at their caps. A run still in progress counts at its caps. In the pilot, the coordinator also
  stops and reports once measured spend passes 1000 AIC.
- **Kill switch.** `FACTORY_ENABLED` must be `"true"` for the router to act and for `v2-port` and `v2-repair` to start.
- **Audit trail.** gh-aw logs and Outcomes for every agent run; the router comments each decision (start, repair,
  stop) and its reason on the language's issue.
- **Repair at most 2, then `needs-human`.** The router counts its repairs and compares failure signatures, and
  repairs only after `gates` passed on the head. A `gates` failure, a merge-queue removal, a spent budget, or an
  agent run that opened no PR or pushed no fix goes straight to `needs-human`.

## Central Agentic Ops (CAO)

[gh-cao](https://github.com/githubnext/gh-cao) (GitHub Next research prototype) collects gh-aw run, cost and outcome
evidence into a dashboard, and runs explicitly integrated workflows under a control repository's reviewed policy
(review/live modes, emergency stop, an optional OIDC admission gate for AI Credits). Not installed here; the owner is
trying it separately.

| v2 piece | CAO could replace it? |
|---|---|
| Audit and dashboards (`outcomes.yml`, the factory dashboard, the pilot's measurements) | **Yes.** CAO Activity and its dashboard show runs, AIC and outcomes across repos, read-only, and mark missing evidence as unavailable, not zero |
| The router's budget gate (`gh aw logs` sum in `v2-router.yml`) | **Partly, later.** The admission gate refuses a gh-aw run at start from policy and fresh accounting, but needs a hosted CAO server (PostgreSQL), a trusted accounting publisher and a gh-aw build with its admission protocol, which pinned v1.0.1 may not speak. It's a cooperative start check, not a reservation |
| Kill switch | **No** (alongside): CAO's emergency stop covers CAO-governed workflows; `FACTORY_ENABLED` stays |
| The test lock (`gates`, rulesets), per-contract `ci` checks, auto-merge and merge queue | **No.** These are repository checks on each PR; CAO doesn't run or replace them |
| Starting a port and the repair/stop rules (`v2-router.yml`) | **No.** CAO dispatches campaign workers across repos; it doesn't react to one PR's `ci`/`gates` results |
| Agent sandbox and identity (gh-aw, agent App) | **No.** Unchanged; CAO runs gh-aw workflows as they are |

So v2 keeps no custom dashboard of its own: if CAO is adopted, it replaces the audit/dashboard parts first, and the
budget gate once the admission gate is available.

## Flow

1. A PR adding `contracts/<lang>/` (onboarding generator output) merges. The router (on `push` to main) opens the
   language's issue and dispatches `v2-port`.
2. `v2-port` ports every contract in dependency order, runs the checks offline (including the gate's own acceptance
   check, `harness/v2/check.js`) and opens one PR with auto-merge on.
3. `ci` and `gates` run. Their completion triggers the router (`workflow_run`), which dispatches `v2-repair` or stops.
4. When the required checks pass, GitHub queues and merges the PR, and the issue closes.

## Files

| File | What it is |
|---|---|
| `.github/factory/v2.yaml` | Languages, budget, caps, `max_repairs` |
| `.github/workflows/v2-router.yml`, `harness/v2/router.js` | The router: start, repair or stop, on events; decisions as issue comments |
| `.github/workflows/v2-port.md`, `v2-repair.md` (+ `.lock.yml`) | The agent runs (gh-aw), compiled with the pinned gh-aw v1.0.1 |
| `harness/gates/scope.js`, `scope-check.js` | `Factory-Unit:` checks (union of the language's contracts) |
| `.github/workflows/ci.yml` | Each contract's golden step, and a 10,000-phrase held-out comparison, for a v2 PR |
| `.github/workflows/outcomes.yml` | gh-aw Outcomes include the v2 runs |

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

## Pilot results (`it`, 2026-11-10)

Done: all 183 `it` golden cases pass (0 pending, 0 failed), the frontier is complete, and a 10,000-phrase comparison
per language (seed 20261110, 170,000 phrases) has 0 mismatches. Merged as #553.

| Stage (UTC) | Attempt 1 | Attempt 2 |
|---|---|---|
| Start → `v2-port` dispatched | 00:46:50 → 00:47:08 (oracle #536 merged) | 01:33:15 → 01:33:38 (`factory-v2:ready` label) |
| Agent run → PR opened | 17 min (#545, 01:04:20) | 19 min (#553, 01:52:28) |
| PR → checks green → queued | gates failed: 4 missing unit tests → `needs-human` | 16 min (auto-merge queued it at 02:08:28) |
| Merge queue → merged | | 14 min (02:22:06) |

- **Total:** 1 h 35 min from the oracle merge to the merge, including the 28 min stop and the fix (#548). Attempt 2
  alone took 49 min.
- **Agent runs:** 2 `v2-port` runs and 0 repairs. First try: 0/1. **CI failures:** 0. **Gates failures:** 1 (attempt
  1). **Copilot findings on agent PRs:** none; Copilot doesn't review bot-authored PRs here, the same as for v1.
- **AIC:** 384.3 in total (attempt 1 193.7, attempt 2 190.5; each about 179 agent + 11.5 detection + 1.2 evals). That's
  about 18 per contract, or 9 for the clean attempt, against v1's measured 35–55 per task (about 840 for 21 tasks).
- **Human touches:** none on the agent PR. The coordinator merged the human-tier PRs (#528, #529, #536, #548) and
  decided the attempt-1 stop: prevent (#548), restart, and keep "gates are never repaired". The restart (closing
  #545, labelling #540) was done at the coordinator's direction.
- **Custom code:** v2 is about 575 lines of plain code (router, offline check, router workflow, `v2.yaml`) plus about
  600 lines of agent prompts adapted from v1, 148 changed lines in shared gates/CI, and 243 lines of tests. v1's
  controller and its watchdogs are 6,743 lines plus 6,817 lines of tests, so v2 is about 1/12 of the plain code.
- **Compared with v1 and vi:** v1 took 2.1 h for nl and 5.7 h for uk; vi's goal-agent run took 1 h 19 min, but with
  the test lock unenforced. v2's clean attempt took 49 min with every v1 guarantee enforced.

**Finding:** one large run can miss a contract's non-golden acceptance (here, unit tests for a step no input reaches),
and gates failures are never repaired. **Lesson:** the agent now runs the gate's own check offline before opening a
PR (`harness/v2/check.js`, #548); attempt 2 passed gates first time.

**Recommendation: migrate, in stages (hybrid for now).** Port the remaining auto-tier languages with v2. Keep v1's
controller for auto-strict and core work, intake fixes and dependency PRs until v2 dispatches the reviewer. Retire
v1's polling dispatch and merge once one more language merges first time on v2.
