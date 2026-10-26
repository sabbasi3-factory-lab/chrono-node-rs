# Factory drills D1–D3: the repair loop

Three hand-written `auto`-tier drill tasks (area `drill`, so they run one at a time, D1 first). Each
port is a tiny parser that never runs (no configuration lists it). The failures are deliberate and
deterministic, so each drill tests one controller path end to end.

| Drill | Task | How it fails | Expected outcome (audit log) |
|---|---|---|---|
| **D1** repair succeeds | `drill/repair-ok` | `ci` step `Drill (deliberate)` fails until the scope file has `// drill: repaired after <failed head SHA>`. The implementer can't know its own commit's SHA in advance (the safe output re-creates commits); the repair gets it as `head_sha` and in `failure.txt`. | `ci` fails → `repair_dispatched` attempt 2 → `ci` green → auto-merge → `task_done` |
| **D2** escalation | `drill/repair-escalate` | The same step requires `drills/D2-unfixable.txt` to say `fixed`, outside the contract's scope, so no repair can pass. | at most 2 repairs, or a stop on the repeated signature `step:drill-deliberate-drills-ci-drill-sh` → `needs_human`. A push outside scope is refused before it lands (repair scope check, #84). If the repair pushes nothing, the task's 24-hour limit hands it on. |
| **D3** gates not repaired | `drill/gates-not-repaired` | Its contract's `golden` acceptance has no `areas`, so the trusted `gates` check rejects every PR for it. | `gates` fails → `needs_human`, **no** `repair_dispatched` |

**Start:** after this PR merges, the build session opens the three task issues (`factory:task`,
`tier:auto`, `area:drill`). Auto-ready (`limits.yaml auto_ready: true`) readies them; nobody marks
them by hand.

**Budget:** at most **300 AIC** for D1–D3 together (implement about 30 per task, plus repairs). The
build session watches the per-task spend on the dashboard and stops the drills at 300 by labelling
the remaining drill issues `blocked`.

## Removal plan

When D1–D3 have concluded (or are stopped at the budget), one owner-tier PR removes the drill:

1. Delete `contracts/drill/`, `drills/`, the `Drill (deliberate)` step in `.github/workflows/ci.yml`,
   and the merged drill parser (`src/locales/en/parsers/factory_drill_repair_ok.rs`).
2. Close the D2 and D3 PRs without merging, and delete their branches.
3. Close the three drill issues: D1 is closed by its merge; close D2 and D3 as not planned, with
   a link to the drill report.
4. Keep the audit log as is (it's append-only). The outcome goes into `docs/JOURNAL.md` at the next
   batched refresh.
