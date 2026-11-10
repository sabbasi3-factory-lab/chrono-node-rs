# review: the factory review's data step (Loop 4)

`.github/workflows/improve.md` is the factory review (DESIGN §15, `cadence.yaml` `factory_review`). Every 3 days, an agent reads a rolling 7-day window of the factory's own data and proposes at most 3 changes in **one report issue** (label `factory-review`). It changes nothing itself.

**Tier:** human (under `harness/` and `.github/`). Agents can't edit it.

## Data (plain code, before the agent; `gather.js`)

| File | From |
|---|---|
| `runs.jsonl` | `gh aw logs <workflow> --start-date -1w --json` (gh-aw's built-in, pinned v1.2.2) for implement, repair and review, one compact line per run |
| `outcomes.json` | gh-aw Outcomes for every completed implement, repair, review, triage, v2-port and v2-repair run in the window: `gh aw logs --outcomes`, one run per call (one bad manifest can't drop other runs' verdicts), newest first, at most 30 runs and never below 400 requests left on the token quota. A run without a verdict carries an `eval_error` saying why (gh-aw's own, over the cap, quota reserve, or a failed call), counted by reason in `summary.md` |
| `audit-counts.json` | the `audit` branch, non-dry-run events of the window: counts by type and reason, merged tasks, first-try merges, repairs, `needs-human` reasons |
| `failures.json` | each `needs_human` event of the window, attributed by `failures.js` to `agent`, `factory`, `platform` (gh-aw / GitHub Actions), `policy`, `factory_or_platform` or `unclear`, strongest signal first: a person's infra-incident record (`factory:infra-incident` + `Infra incident: <ref>`, the audit log's `human_action/infra_incident`, or the label alone); where the failed run stopped (below); a reason code that names a factory control or policy hold (`missing_heldout_seed`, `task_budget_exhausted`, …); the pre-triage verdict for **that** hand-off (after it, before the issue's next needs-human) (`**Likely cause:** \`<class>\`` in the triage workflow's comment: `github-actions[bot]` with gh-aw's `triage` marker; class and confidence only). `implement_failed`, `repair_failed` and `review_timeout` with no resolving signal stay `unclear`, never `agent`. For `repair_failed` the event's `run_id` is the failing CI run, so the repair run is resolved like the controller does (its `repair_dispatched` record, then the run titled `Repair <task> #<issue> attempt <n>` within 30 minutes) |
| `platform-reliability.json` | every failed run of every gh-aw workflow (`*.lock.yml`) in the window, classified from the Actions jobs API and the failed jobs' annotations: a gh-aw step before the agent ran (`mcp_gateway_start`, `agent_setup:<step>`), threat detection with no result (`detection_no_result`) or failing to set up, a factory-owned step (anything the workflow source defines: `steps:`, `pre-agent-steps:`, `post-steps:`, `safe-outputs.threat-detection.steps` such as repair's scope gate, `safe-outputs.steps`, custom `jobs:`; checked before the platform rules; kill switch and budget gate are `policy`; unreadable or CRLF-mangled frontmatter fails the step), the agent reporting it couldn't finish (`agent_reported`), a real detection verdict (`verdict`), or `unclear` (including the agent's own execution failing: engine or agent). Platform failures by kind with run links; a kind seen **2+ times** is `recurring` (report upstream to github/gh-aw). Uploaded as the `factory-review-data` artifact (90 days), which the dashboard reads |
| `areas.json`, `summary.md` | each area's last change and eligibility: the prompts' last commit here, and the policies' last commit in the factory repo at the pinned version. An area is eligible with **15+ tasks merged since its last change** (`cadence.yaml` `min_tasks_since_last_change_in_area`), counted inside the window. An unknown last change is never eligible. |

The agent gets these files and read-only GitHub tools, and has no network. API cost per run: about 7 run listings, one jobs call and one annotations call per failed run (at most 60 runs), one comments page per needs-human issue, one label listing.

## Proposals

- At most 3, each with evidence from the files, each with a class:
  - `prompt` and `policy`: only in eligible areas.
  - `factory-code`: a concrete change to the factory (component, behaviour today and after, failures it would have prevented) for a person or the coordinator to implement. Needs 2+ failures in the window with the same `factory` or `platform` cause. A retry may only re-run what failed before the agent ran or without a verdict.
- Failures count against a prompt only when attributed `agent` (`failures.json`), never by timing.
- **Prompt changes:** a gh-aw `experiments:` block (the control keeps today's text; the treatment is gated with gh-aw's conditional on the variant), with hypothesis, metric, guardrails and `min_samples`. They're measured, never applied directly.
- **Policy changes:** exact YAML diffs for `policies/<file>.yaml` in the factory repo, marked "tightens" or "loosens".
- Adopting a proposal is a person's PR. The factory repo stays agent-free: no App writes there. Prompt files are under `.github/workflows/`, which no factory App can push to.

## Spend

`improve` is in the controller's `CAPPED_WORKFLOWS` (budgets.yaml `per_run.factory_review` 500, `per_workflow_per_day.factory_review` 1000, threat detection 400). The controller verifies its compiled caps, reserves an in-flight run at 900, and measures or bounds it like any AI run. Its runs count toward the factory's daily total but toward no task's budget (`spend.ts` `TASKLESS_FILES`), even when one can't be read. Cron starts it, not the controller, so it gates itself before any inference (`budget-gate.js`): today's newest live `spend_snapshot`, plus its worst case (500 + 400 + 2 × the overshoot margin), must stay under `factory_per_day.max_aic × pause_at_pct`. Unknown spend means no run.

## Drill

- 2026-11-05, live window (after #339 attributed 7 failures by timing): 7 needs-human, all attributed correctly: `factory` 5 (#291, #296, #298, #300: infra incident #303; #216: `missing_heldout_seed`), `platform` 2 (#327: `mcp_gateway_start`, run 42053301543; #318: `detection_no_result`, run 42057503725). 10 failed gh-aw runs: platform 2, factory 1 (the drill's `Validate dispatch` step), agent_reported 4, unclear 3 (queue-dispatch/queue-probe safe outputs).
- Locally: `GH_TOKEN=… node review/gather.js --out /tmp/rv --logs <dir with gh aw logs JSON> --outcomes <dir with one <run_id>.json per run>` gave, on 2026-11-04, 22 merged tasks (all first try), 0 repairs and 27 Outcomes runs. Eligible: `prompt:repair`, `prompt:review`, and `policy:tiers|dependencies|network|cadence`. Not eligible: `prompt:implement` (changed today, 4 tasks since), `policy:budgets|limits` (4).
- After merge: run `improve` by hand (with `FACTORY_ENABLED=true`). Expect one `[factory-review]` issue, and the run's spend in the next `spend_snapshot` (reserved at 900 while in flight).

## Tests

`npm run test:gates` (in `harness/`) runs `review/test/`; the controller's `npm test` covers the spend and cap checks.
