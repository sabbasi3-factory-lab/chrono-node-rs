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

Shared-infrastructure gaps (like the JS regex `u` flag in #208) surface the same way they did by
hand: the task's golden cases fail, and the task goes to `needs-human` with the failure signature.

## Fails closed

`add` refuses a locale, with the reason, when:
- a configuration uses a step that's neither one of the locale's files nor already in the task map;
- a step has no golden case and no generated phrase reaches it (today `it`: `ITMergeRelativeAfterDateRefiner`, `ITUnlikelyFormatFilter`; `vi`: `VIMergeWeekdayComponentRefiner`): a hand decision;
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

1. **decide**: a dispatch with a code (someone with write access), or the daily schedule:
   `onboard.js next` takes the next language from factory `policies/onboarding.yaml` (the owner's list),
   one at a time (no open onboarding PR, no generated locale with open tasks beyond
   `max_languages_in_flight`), and stops on the policy's stop rules: AI credits spent on generated
   locales' tasks (gh-aw Outcomes) reach `budget_aic`; first-try merge rate below
   `min_first_try_merge_rate` after `min_sample` merged tasks; `max_open_needs_human` open
   needs-human tasks. No policy, unreadable outcomes or no budget = no onboarding (fail closed).
   **Coverage.** The spend and first-try rules read `outcomes.json`, which the outcomes collector
   fills a few runs per invocation, so it lags. The decision also reads the ledger of what ran and
   merged: completed agent runs from the Actions API and merged agent PRs. It waits
   (`outcomes_behind:N`) until `outcomes.json` has every ledger run of a generated locale's task
   (and every review run since the first of those), each with a cost, and an accepted PR for every
   merged task. A covered review that outcomes attributes to no task counts toward the spend. A missing or unreadable input (issues, PRs, runs, merged) also waits, never reads
   as "none". The `onboard-stop-rules` fire drill checks this. (#317 onboarded `id` on 0 AIC and
   0/0 first-try because `outcomes.json` had none of `fi`'s runs yet.)
   **Infra incidents.** When a factory defect (not agent work) broke a task's attempts, a person
   adds `factory:infra-incident` to the task issue (open or closed) and comments `Infra incident:
   <ref> <reason>`, where `<ref>` is the fixing PR or incident issue (`#303`). The controller records
   it in the audit log (`human_action`, `action: infra_incident`: issue, task, actor, time, ref and
   the comment's URL); a bot or App adding the label, or a comment without a ref, records nothing.
   For the first-try rate only, that task's implement attempts started before the record that
   opened no accepted PR aren't counted. Spend counts every run, and the threshold is unchanged.
2. **generate**: the generator on main with a read-only token, then the exact file set is checked.
3. **apply** (live): the controller App opens `factory/onboard/<code>`. Human tier.
4. **issues** (live, after merge): task issues with "blocked by" links (`issues.js`, no third-party
   code next to the write token). The controller's auto-ready dispatches unblocked auto-tier tasks.
5. **alert** (live): a stop opens one `factory:alert` issue per reason.

Kill switch: unless `FACTORY_ENABLED` is exactly `"true"`, nothing is written.

## Commands

```sh
node onboard/onboard.js candidates        # upstream locales not onboarded yet
node onboard/onboard.js add fi            # onboard one (writes the files above)
node onboard/onboard.js check             # CI: every generated locale re-renders byte for byte
node onboard/onboard.js check --write     # after a generator change: re-render the generated locales in place
node onboard/onboard.js drill [code...]   # onboard each (default: every candidate) in a throwaway copy;
                                          # fail if a contract scope file's directory isn't generated,
                                          # or onboard.yml's artifact would drop the skeleton's .gitkeep files
node onboard/onboard.js next --policy P --outcomes O --issues I --prs R --runs U --merged M [--incidents A]   # the scheduled decision (A: audit jsonl)
node onboard/summary.js fi                # the onboarding PR's body
node --test onboard/test/*.test.js        # unit tests (also in npm run test:gates)
```
