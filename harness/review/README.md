# review: the factory review's data step (Loop 4)

`.github/workflows/improve.md` is the factory review (DESIGN §15, `cadence.yaml` `factory_review`). Every 3 days, an agent reads a rolling 7-day window of the factory's own data and proposes at most 3 changes in **one report issue** (label `factory-review`). It changes nothing itself.

**Tier:** human (under `harness/` and `.github/`). Agents can't edit it.

## Data (plain code, before the agent; `gather.js`)

| File | From |
|---|---|
| `runs.jsonl` | `gh aw logs <workflow> --start-date -1w --json` (gh-aw's built-in, pinned v1.0.1) for implement, repair and review, one compact line per run |
| `outcomes.json` | the `outcomes` branch (gh-aw Outcomes, written by `outcomes.yml`) for runs in the window |
| `audit-counts.json` | the `audit` branch, non-dry-run events of the window: counts by type and reason, merged tasks, first-try merges, repairs, `needs-human` reasons |
| `areas.json`, `summary.md` | each area's last change and eligibility: the prompts' last commit here, and the policies' last commit in the factory repo at the pinned version. An area is eligible with **15+ tasks merged since its last change** (`cadence.yaml` `min_tasks_since_last_change_in_area`), counted inside the window. An unknown last change is never eligible. |

The agent gets these files and read-only GitHub tools, and has no network.

## Proposals

- Only in eligible areas, at most 3, each with evidence from the files.
- **Prompt changes:** a gh-aw `experiments:` block (the control keeps today's text; the treatment is gated with gh-aw's conditional on the variant), with hypothesis, metric, guardrails and `min_samples`. They're measured, never applied directly.
- **Policy changes:** exact YAML diffs for `policies/<file>.yaml` in the factory repo, marked "tightens" or "loosens".
- Adopting a proposal is a person's PR. The factory repo stays agent-free: no App writes there. Prompt files are under `.github/workflows/`, which no factory App can push to.

## Spend

`improve` is in the controller's `CAPPED_WORKFLOWS` (budgets.yaml `per_run.factory_review` 500, `per_workflow_per_day.factory_review` 1000, threat detection 400). The controller verifies its compiled caps, reserves an in-flight run at 900, and measures or bounds it like any AI run. Its runs count toward the factory's daily total but toward no task's budget (`spend.ts` `TASKLESS_FILES`), even when one can't be read. Cron starts it, not the controller, so it gates itself before any inference (`budget-gate.js`): today's newest live `spend_snapshot`, plus its worst case (500 + 400 + 2 × the overshoot margin), must stay under `factory_per_day.max_aic × pause_at_pct`. Unknown spend means no run.

## Drill

- Locally: `GH_TOKEN=… node review/gather.js --out /tmp/rv --logs <dir with gh aw logs JSON>` gave, on 2026-11-04, 22 merged tasks (all first try), 0 repairs and 27 Outcomes runs. Eligible: `prompt:repair`, `prompt:review`, and `policy:tiers|dependencies|network|cadence`. Not eligible: `prompt:implement` (changed today, 4 tasks since), `policy:budgets|limits` (4).
- After merge: run `improve` by hand (with `FACTORY_ENABLED=true`). Expect one `[factory-review]` issue, and the run's spend in the next `spend_snapshot` (reserved at 900 while in flight).

## Tests

`npm run test:gates` (in `harness/`) runs `review/test/`; the controller's `npm test` covers the spend and cap checks.
