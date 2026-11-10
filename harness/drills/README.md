# Fire drills

Plain code, no AI. They prove the guardrails still bite (factory `policies/cadence.yaml`:
`fire_drills: weekly, at random times ... (dry-run first)`).

**Tier:** human, like the rest of `harness/`.

`drill-schedule.yml` rolls 4 times a day and starts `drills.yml` about once a week at a random
slot, and always when the last passing drill run is more than 7 days old. `drills.yml` runs:

| Drill | Fault planted (in a throwaway copy) | Guardrail that must bite | Control (must pass) |
|---|---|---|---|
| `golden-mismatch` | one checked `en/weekday` expectation's index + 1 | the golden suite fails, exactly 1 case | the unchanged area passes |
| `comparison-mismatch` | `compare.js --plant` (today's seed) | exactly 1 mismatch reported, exit 1 | same seed without the plant: 0 |
| `scope-reject` | an agent PR for a real contract on main touching `src/core/chrono.rs`; one touching `.github/workflows/ci.yml`; one with a stale `Contract-SHA` | `gates/scope.js` rejects each, with its reason (live `protected_from_agents`) | the in-scope change passes |
| `kill-switch` | `FACTORY_ENABLED` unset, `""`, `"TRUE"`, `"1"` | the controller (fixture mode, live policies) dispatches nothing; `kill_switch` holds | with `true` it would dispatch |
| `over-cap` | spend today at the live `factory_per_day.max_aic`, and at `alert_at_pct` | paused (no dispatch) at the cap; owner alert at the threshold | 0 AIC dispatches |
| `onboard-stop-rules` | `onboard.js next` inputs (live `onboarding.yaml`): the audit log without the locale's run costs (#317), missing one, or empty; issues or the run ledger unreadable; spend at the budget; a person touched every merged PR; a generated contract without its task issue past the grace period | the decision doesn't onboard (waits or stops) | complete data: it onboards |
| `onboard-hints` | copies of `harness/onboard/hints.yaml`: a step its own seed reaches declared unreachable; a seed that reaches nothing; an unreachable step with an empty probe corpus | `onboard.js hints-check` fails each | the real hints hold against the pinned chrono-node |
| `audit-tamper` | the real audit log with one payload byte changed; truncated to half | the factory's audit verifier (pinned) fails both | the real log verifies against the anchors |

Every drill is a **dry run**: nothing is written to GitHub. A failure in live mode
(`FACTORY_ENABLED=true`) opens or comments on one `factory:alert` issue.

**Agentic workflow canary** (`canary.js`, `.github/workflows/agentic-canary.yml`, live only). It
dispatches each AI workflow the controller uses (implement, repair, review, triage) for the sentinel
task `drill/activation-canary`, which has no contract. gh-aw's activation must succeed, and the
workflow's own validation must then refuse the task before the agent's inference. gh-aw's threat
detection still runs on the empty output (~10 AIC per run, ~40 AIC a day). It runs
daily and on every main change to an agentic workflow or lock; a failure raises a `factory:alert`.
It exists because #393's reviewer failed in activation (a stale lock, E009) the first time an
auto-strict task needed it. `drill/` runs are excluded from the first-try rates, the results page and the factory review.
CI's `checks` job also recompiles the factory's agentic workflows with the pinned gh-aw and fails on
any lock diff, so a stale lock can't merge.

**Results.** Each `drills` run is recorded in the audit log by the controller (a `check_result`
event, `workflow: drills`). A failed run shows on the dashboard's recent activity as "drills failed".
The per-drill detail is the run's summary and its `drill-results` artifact (kept 90 days).

**The drills were drilled.** Each guardrail was broken on purpose once, and its drill failed:
kill switch on for an empty value, the budget pause disabled, the scope check disabled, the golden
comparison disabled, and the verifier's sha check disabled.

```sh
# locally (after npm ci here and in .github/factory/controller, npm run build:upstream, cargo build --bin chrono-rs-json)
POLICIES_DIR=<dir with the pinned limits/budgets/tiers/cadence/onboarding.yaml> AUDIT_GIT_DIR=.. AUDIT_HEAD=$(git rev-parse origin/audit) \
FACTORY_GIT_DIR=<factory clone with origin/anchors> node drills/drills.js run --out results.json
node --test drills/test/*.test.js
```
