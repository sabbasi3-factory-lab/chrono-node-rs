# Language onboarding

Plain code, no AI. It replaces the hand-written setup session each language used to need (the
scaffold, golden and contracts PRs: #162/#163 for German and French, #208/#209 for wave 1).

**Tier:** human, like the rest of `harness/`.

## What is generated, and what isn't

`node onboard/onboard.js add <code>` (after `npm ci` here and in `scripts/seed-backlog/`, and `npm run build:upstream`):

| Output | From |
|---|---|
| `src/locales/<module>/locale.json` | the code: the manifest every other tool reads (`../lib/locales.js`) |
| `tests/golden/<module>/*.json`, `index.json`, `configurations.json` | the golden generator, now also running `upstream/test/<code>/` and recording the locale's exported `casual` / `strict` |
| `harness/golden/coverage/<module>.json` → `tests/golden/<module>/coverage.json` | only for steps no upstream test reaches: the first 3 requests of a fixed phrase stream (the comparison's golden-text phrases, seeded by the module name) whose chrono-node trace needs the step. Their expected results are chrono-node's, like every golden case. |
| `src/locales/<module>/mod.rs`, `configuration.rs` | `configurations.json`: every slot, in upstream order, with its flags. `build.rs` declares the module, so no shared line changes. |
| `src/locales/<module>/parsers/.gitkeep`, `refiners/.gitkeep` (and any other directory a task's scope file goes in) | the task map fragment: the **module skeleton**. Every contract scope file's parent directory exists on main, so no agent needs `mkdir` (its bash allowlist has none, and the edit tool needs an existing parent). `build.rs` auto-registers `parsers/` and `refiners/`, and compiles them empty. A scope file outside `src/locales/<module>/` is refused. |
| `scripts/seed-backlog/taskmap.d/<module>.yaml` | upstream's file structure: one task per step of the locale's configurations; one **support task** per shared file the steps import (`constants.ts`, a locale's `Abstract…` base). Areas from what the step does (casual, time, relative, dates, refiners, support). |
| `contracts/<code>/*.yaml` | the seed script, from the fragment |

Not generated: everything that needs judgement. Porting the constants and each step is ordinary
factory work:
- **constants** (support task): its unit cases are recorded from the compiled upstream module: every
  exported pattern and dictionary exactly, and each one-argument function on up to 8 inputs (the
  patterns' matches in the locale's golden texts, the dictionaries' words and a few numerals; at most 3 per
  kind of input, so JS quirks such as `parseYear("15min") = 2015` get pinned).
- **a shared base** (support task): a requirement; the steps that use it depend on it and their golden cases check it.
- **steps**: golden cases, as before.
- **a step no input reaches** (declared in `hints.yaml`, see below): unit cases recorded by running
  the upstream step alone on given inputs, plus the differential comparison; no golden case.

Shared-infrastructure gaps (like the JS regex `u` flag in #208) surface the same way they did by
hand: the task's golden cases fail, and the task goes to `needs-human` with the failure signature.

## Fails closed

`add` refuses a locale, with the reason, when:
- a configuration uses a step that's neither one of the locale's files nor already in the task map;
- a step has no golden case, no generated phrase reaches it and `hints.yaml` neither has a seed that
  reaches it nor declares it unreachable: a hand decision;
- a `hints.yaml` entry is stale: a step declared unreachable that an upstream test, a generated
  phrase or its probe corpus reaches;
- two tasks would write the same Rust file;
- a contract scope file's directory isn't generated (checked after the contracts are written).

## Guarantees

- **Byte-reproducible.** CI runs `onboard.js check` (every generated locale's manifest, scaffold,
  module skeleton, fragment and coverage input re-rendered from `upstream/` and `tests/golden/`, and
  every contract scope file's directory present), `golden:check` and,
  on `factory/onboard/*` PRs, `seed.js contracts --check`.
- **Additive.** Onboarding adds files and the two golden indexes' entries. Existing goldens,
  phrase streams and contracts don't change (golden facts are scoped per locale and generated
  priorities start at 1000), so in-flight tasks never go `stale-contract`.

## The pipeline (`.github/workflows/onboard.yml`)

1. **decide**: a dispatch with a code (someone with write access), or the policy's decision, run
   when a factory task issue closes (the last task of a language starts the next one at once) or
   opens (the next language follows as soon as the previous one's issues exist), and hourly as a
   fallback. `onboard.js next` takes the next language from factory
   `policies/onboarding.yaml` (the owner's list), one at a time (no open onboarding PR, no generated
   locale in flight beyond `max_languages_in_flight`), and stops on the policy's stop rules: AI
   credits spent on generated locales' tasks reach `budget_aic`; first-try merge rate below
   `min_first_try_merge_rate` after `min_sample` merged tasks; `max_open_needs_human` open
   needs-human tasks. No policy or no budget = no onboarding (fail closed).
   **In flight.** A generated locale is in flight while it has open task issues, and also while
   any of its contracts has no task issue (`task_issues_pending`): the issues jobs below haven't
   finished. Two hours after its onboarding PR merged (or with no record of that merge) that stops
   (`task_issues_missing`, an alert): the next language never starts on top of a half-issued one.
   Several languages may be in flight (`max_languages_in_flight` 5 since the owner's decision of
   2026-11-09): each decision onboards at most one, the next waits for its onboarding PR to merge
   and its issues to exist, and the stop rules count across every generated locale. Generated
   contracts are locale-local (area `<code>-…`, scope under the locale's own paths), so tasks of
   different languages never hold each other's area lock.
   **External locales.** The policy's `external_locales` (vi since the owner's decision of
   2026-11-09: ported outside the factory, as an A/B against it; it since the owner's decision of
   2026-11-09: the factory v2 pilot) may be generated on main: their
   oracle, golden cases and code, which CI checks like any locale (goldens, frontier, comparison).
   The factory never runs them: no decision picks one (nor a dispatch: `candidates --policy`), no
   task issue is created (`issues.js --policy`; an unreadable policy creates none), the controller
   never dispatches or auto-readies one, and they're left out of the in-flight count and every stop
   rule.
   **Data: current records, no collector.** Spend: each run's full cost (agent, threat detection,
   evals) from the controller's audit log: its `run_spend` event, written once the run has finished
   (`.github/factory/controller/spend.ts`); for runs from before those, its newest `spend_snapshot`
   entry (an in-flight reservation, an overestimate). A run counted at its bound because a usage
   file was missing counts at the larger of its readable usage files and its agent's own figure
   (the agent-only figure gh-aw reports in `gh aw logs`; never less than the rule read before), else at its bound. First
   try: one implement run, no repair, and the merged PR zero-touch by gh-aw's rule (no comment,
   review or commit by a person; GraphQL on the merged agent PRs). **Coverage.** The ledger of what
   ran and merged comes from the Actions API and GraphQL. The decision waits (`records_behind:N`)
   until the audit log has a cost for every ledger run of a generated locale's task (and every
   review run since the first of those, which counts toward the spend: a review names no task) and
   every merged task's zero-touch verdict is known. A missing or unreadable input (issues, PRs,
   onboarding merges, contracts, runs, merged PRs, audit log) also waits, never reads as "none".
   The `onboard-stop-rules` fire drill checks this. (#317 onboarded `id` on 0 AIC and 0/0
   first-try because the data it read had none of `fi`'s runs yet.) The decision and a stop's alert show the spend as `measured` (runs with their
   final `run_spend`) plus `reserved` (runs whose final cost isn't recorded yet, at their in-flight
   reservation): the rule counts both. On 2026-11-09 the `it` decision logged 9,204 = 4,004 measured
   + 5,200 reserved, two finished zh-hans runs whose final cost (79 in all) landed a minute later.
   **Infra incidents.** When a factory defect (not agent work) broke a task's attempts, a person
   adds `factory:infra-incident` to the task issue (open or closed) and comments `Infra incident:
   <ref> <reason>`, where `<ref>` is the fixing PR or incident issue (`#303`; it may end a sentence:
   `Infra incident: #475. The attempt…`). The controller records
   it in the audit log (`human_action`, `action: infra_incident`: issue, task, actor, time, ref and
   the comment's URL); a bot or App adding the label, or a comment without a ref, records nothing.
   For the first-try rate only, that task's implement attempts started before the record, other
   than the one whose PR merged, aren't counted. Spend counts every run, and the threshold is unchanged.
   **A conflicting onboarding PR.** An open onboarding PR that conflicts with main (GitHub's
   `mergeable_state: dirty`: another PR changed a shared golden index, `tests/golden/index.json` or
   `configurations.json`, after it was generated; #494 and the external vi oracle #491, 2026-11-09)
   would wait forever. The decision reads each open onboarding PR's commits and files
   (`--onboard-prs`) and, when it's still pure generator output (`lib.pureGeneratorPr`: exactly one
   commit, authored and committed by the controller App, with apply's message and one parent; only
   generator paths; the head unchanged), decides `regenerate`: the generator runs on current main and
   apply replaces the branch with a lease on the checked head, then refreshes the same PR's
   description and comments. Same branch and PR, so `max_per_day` (merged onboarding PRs) counts it
   once. Anything else on the PR (a person's commit, another file, a rebase) stops with
   `onboarding_pr_conflict:<code>` and an alert: a person resolves it. Mergeability not yet computed
   (`unknown`) or the details unreadable: wait, as before.
2. **generate**: the generator on main with a read-only token, then the exact file set is checked.
3. **apply** (live): the controller App opens `factory/onboard/<code>` (or, for `regenerate`,
   force-pushes it with a lease and updates the existing PR). Human tier.
4. **issues** (live, after merge): task issues with "blocked by" links (`issues.js`, no third-party
   code next to the write token). The controller's auto-ready dispatches unblocked auto-tier tasks.
5. **alert** (live): a stop opens one `factory:alert` issue per reason.

Kill switch: unless `FACTORY_ENABLED` is exactly `"true"`, nothing is written.

## Hand-reviewed hints (`hints.yaml`, human tier)

Where the generated phrase stream can't find coverage, a person adds evidence once, and the
generator re-checks it against the pinned chrono-node on every render:
- **seeds**: hand-written input texts for a step. A seed is kept only if the trace shows the step
  changing the result, and its expected output is recorded from chrono-node like any golden case.
  It's tried after the phrase stream, so other locales' coverage never changes. (`it`:
  `ITMergeRelativeAfterDateRefiner`. The stream never writes `<date> +2 settimane`.)
- **unreachable**: a step no input can exercise in the pinned upstream, with the reason (an argument
  from the patterns) and an adversarial probe corpus that must never reach it: every sequence of up
  to `max_tokens` tokens, in each frame. The step is still ported: its contract's acceptance is the
  recorded unit cases. (`it`: `ITUnlikelyFormatFilter`, which needs a result text no Italian pattern
  can end with; 296,472 traces.)
- Seeds also cover `vi`'s `VIMergeWeekdayComponentRefiner`: with two weekdays before a date, the
  common `MergeWeekdayComponentRefiner` merges only the second, and the VI subclass then merges the
  first (it was first declared unreachable by a chain-order argument that was wrong; #357 review).

`onboard.js hints-check` re-checks every entry, and the `onboard-hints` drill checks that broken
copies fail.

## Commands

```sh
node onboard/onboard.js candidates        # upstream locales not onboarded yet
node onboard/onboard.js add fi            # onboard one (writes the files above)
node onboard/onboard.js check             # CI: every generated locale re-renders byte for byte
node onboard/onboard.js check --write     # after a generator change: re-render the generated locales in place
node onboard/onboard.js drill [code...]   # onboard each (default: every candidate) in a throwaway copy;
                                          # fail if a contract scope file's directory isn't generated,
                                          # or onboard.yml's artifact would drop the skeleton's .gitkeep files
node onboard/onboard.js next --policy P --issues I --prs R --onboard-merges O --runs U --merged M --audit A   # the decision (A: audit jsonl)
node onboard/onboard.js hints-check      # hints.yaml still holds against the pinned chrono-node
node onboard/summary.js fi                # the onboarding PR's body
node --test onboard/test/*.test.js        # unit tests (also in npm run test:gates)
```
