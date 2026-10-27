# Factory drills: the repair loop (D1–D3, D1b) and the auto-strict path (D4–D8)

Three hand-written `auto`-tier drill tasks (area `drill`, so they run one at a time, D1 first). Each
port is a tiny parser that never runs (no configuration lists it). The failures are deliberate and
deterministic, so each drill tests one controller path end to end.

| Drill | Task | How it fails | Expected outcome (audit log) |
|---|---|---|---|
| **D1** repair succeeds | `drill/repair-ok` | `ci` step `Drill (deliberate)` fails until the scope file has `// drill: repaired after <failed head SHA>`. The implementer can't know its own commit's SHA in advance (the safe output re-creates commits); the repair gets it as `head_sha` and in `failure.txt`. | `ci` fails → `repair_dispatched` attempt 2 → `ci` green → auto-merge → `task_done` |
| **D2** escalation | `drill/repair-escalate` | The same step requires `drills/D2-unfixable.txt` to say `fixed`, outside the contract's scope, so no repair can pass. | at most 2 repairs, or a stop on the repeated signature `step:drill-deliberate-drills-ci-drill-sh` → `needs_human`. A push outside scope is refused before it lands (repair scope check, #84). If the repair pushes nothing, the task's 24-hour limit hands it on. |
| **D1b** unaided repair push | `drill/repair-unaided` | Same as D1. Added after D1's repair push failed on a missing App permission (fixed in #97) and D1 completed only after one manual replay. | Same as D1, with **no person in the loop**: the controller's own repair dispatch pushes, `ci` goes green, auto-merge, `task_done`. Runs after D3 (priority 4). |
| **D3** gates not repaired | `drill/gates-not-repaired` | Its contract's `golden` acceptance has no `areas`, so the trusted `gates` check rejects every PR for it. | `gates` fails → `needs_human`, **no** `repair_dispatched` |

**Start:** after this PR merges, the build session opens the three task issues (`factory:task`,
`tier:auto`, `area:drill`). Auto-ready (`limits.yaml auto_ready: true`) readies them; nobody marks
them by hand.

**One at a time, closed as each concludes:** all three share area `drill`, and the controller
counts an open PR or a picked issue as in flight, so a drill left at `needs_human` would hold the
area. As soon as D2 or D3 reaches its outcome (recorded in the audit log), the build session closes
that drill's PR (without merging, branch deleted) and its issue (as not planned, linking the audit
events), so the next drill can start. D1 closes itself by merging.

**Budget:** at most **300 AIC** for D1–D3 together (implement about 30 per task, plus repairs). The
build session watches the per-task spend on the dashboard and stops early, before 300: it labels
every open drill issue and PR `needs-human` (what admission and repair check; `blocked` alone
doesn't stop a ready or picked task), then cancels any queued or running implement or repair run
for a drill task.

## D4–D8: the auto-strict path, before the promotion

Seven hand-written **`auto-strict`** drill tasks. Before the promotion, the controller runs
auto-strict only for tasks matching tiers.yaml `auto-strict.promote_tasks` (`drill/*`) whose every
scope path matches `promote_tasks_paths` (`src/locales/en/parsers/factory_drill_*.rs`); `start_as:
human` holds for every other task (#109). Drill files are compiled but never registered (`build.rs`
leaves `factory_drill_*` out of the registry and checks each `UPSTREAM` starts with `FactoryDrill`), so
a merged drill can't change what chrono parses. Each deliberate failure is deterministic and can
only make a check **fail**, never pass.

| Drill | Task (area) | How it fails | Pass criterion (audit log unless noted) |
|---|---|---|---|
| **D4** reviewer objects | `drill/reviewer-objects` (`drill`) | Its `extract` calls `m.get(1).unwrap()` on a pattern without group 1: a panic reachable from input, which the reviewer must fail. | `ci` and `gates` green → `review_dispatched` → `needs_human` / `review_objected`; **no** `auto_merge`. |
| **D5** full regression fails | `drill/full-regression` (`drill`) | `ci-drill.sh full-regression`, run inside the full-regression step, fails any PR that changes the D5 file; nothing in scope can fix it. | `ci` fails at `Full regression (auto-strict)` → repair (can't fix) → `needs_human` (`repair_no_push`, #106); **no** `review_dispatched` or `auto_merge`. |
| **D6** strict lane 1 | (the D8 tasks) | The D8 tasks have their own areas, so auto-ready readies them while another drill is in flight; the strict lane (`limits.wip.core_area`, capped at 1) holds them. | A ready, unpicked D8 issue while another drill task is in flight, and the controller's run log (`logWaits`, #110) shows `[live] wait (core_area_busy) task=drill/gate-…`. Waits aren't in the audit log. |
| **D7** post-merge failure | `drill/post-merge` (`drill`) | Its PR passes everything and is auto-merged. `ci-drill.sh post-merge` (push to `main` only) fails when the pushed commit **adds** the D7 file; the revert, which deletes it, passes. | `auto_merge` → merged → `main_ci_rerun` (confirm) → `auto_revert` and a revert PR from `factory/revert-*`. The coordinator then labels it `factory:revert-reviewed` (a human action) and merges it. |
| **D8a** semver gate | `drill/gate-semver` (`drill-gate-semver`) | Deletes the merged D1b drill file, removing public items. | `ci` fails at `Strict gate - semver_checks`; the PR doesn't merge while it fails. |
| **D8b** mutation gate | `drill/gate-mutation` (`drill-gate-mutation`) | A new branchy `pub fn drill_score` with no tests: new code below the 0.8 floor. | `ci` fails at `Strict gate - mutation_score_not_lower`; not merged while failing. |
| **D8c** perf gate | `drill/gate-perf` (`drill-gate-perf`) | `benches/golden_phrases.rs` does every iteration twice when the D8c file exists (about +100%). `perf.sh` refuses a base that has the file, so the hook can't hide a regression (`harness/gates/test/perf-drill.test.js`). | `ci` fails at `Strict gate - perf_regression_max_pct` (slower twice); not merged while failing. |
| **D8d** code-health gate | `drill/gate-code-health` (`drill-gate-code-health`) | A `pub struct` with four `bool` fields: `clippy::struct_excessive_bools`, which the gate counts (pedantic, so plain `clippy -D warnings` passes). | `ci` fails at `Strict gate - code_health_not_worse`; not merged while failing. |

The strict gates run as steps of one `ci` job in a fixed order (semver, mutation, perf, code
health) and stop at the first failure, so each D8 drill passes the gates before its own. A strict
gate failure is a `ci` failure, so the controller sends it to repair: a repair that fixes it is fine
(the drill still showed the gate blocking); one that can't hands it on (`repair_no_push`).

**Start:** after this PR merges (and #109, which enables `promote_tasks`), the build session opens
the seven issues (`factory:task`, `tier:auto-strict`, area label). Auto-ready readies them.

**Order and closing:** D4, D5 and D7 share area `drill`; the strict lane allows one auto-strict task
in flight across all areas. Priorities run D4 (5) to D8d (11). As each drill reaches its outcome,
the build session closes its PR (without merging) and issue, as for D2 and D3. D7 closes itself by
merging; its revert PR is the coordinator's.

**D7 needs a quiet `main`:** the controller reverts only main's tip, so nothing else may merge
between D7's merge and the revert PR (otherwise `revert_not_safe`, a person's call).

**Budget:** at most **400 AIC** for D4–D8 (implement about 27, repair about 25, review about 20 per
run): roughly D4 50, D5 55, D7 50, D8 4 × 52, about 360 with every D8 repaired. If spend reaches
**350**, the build session stops before starting the next drill and reports, the same way as above.

## Removal plan

When D1–D3, D1b and D4–D8 have concluded (or are stopped at the budget), one owner-tier PR removes
the drills:

1. Delete `contracts/drill/`, `drills/`, both drill steps in `.github/workflows/ci.yml` (`Drill
   (deliberate)` and `Drill (deliberate, post-merge)`) and the `ci-drill.sh full-regression` line in
   the full-regression step, the D8c hook in `benches/golden_phrases.rs` and its guard in
   `harness/strict/perf.sh` (with `harness/gates/test/perf-drill.test.js`), and every merged drill
   parser (`src/locales/en/parsers/factory_drill_*.rs`).
2. In the same change, a factory PR removes `auto-strict.promote_tasks` and `promote_tasks_paths`
   from tiers.yaml, and the removal PR bumps factory-version to it. The controller's
   `drillPromoted` and the scope check's drill rule then promote nothing; remove them, and
   `build.rs`'s drill handling, once no drill file is left.
3. Check that every drill PR and issue is closed and its branch deleted.
4. Keep the audit log as is (it's append-only). The outcome goes into `docs/JOURNAL.md` at the next
   batched refresh.
