# seed-backlog

The seed script (DESIGN §6). It's deterministic, uses no AI, and needs no network except reading `policies/tiers.yaml` from the factory repo at the pinned factory version.

```sh
cd scripts/seed-backlog && npm ci
node seed.js contracts           # write contracts/<id>.yaml
node seed.js contracts --check   # fail if contracts/ is stale
node seed.js issues --plan       # print the issues the contracts would become (no writes)
node seed.js issues --plan --only <id>[,<id>]    # only these contracts (the intake's fix tasks)
node seed.js labels [--check]    # create the factory's labels (.github/factory/labels.json) and the contracts' tier:/area: labels if missing
npm test                         # unit tests
```

## Inputs, and what is derived

| Contract field | From |
|---|---|
| `id`, `area`, `scope`, `source`, `upstream_class` | `taskmap.yaml` (owner-approved): one upstream step → one Rust file |
| `source_sha` | `upstream/PINNED.md` |
| `tier` | `factory/policies/tiers.yaml` at `.github/factory/factory-version`, matched against `scope`. `auto-strict` paths use `start_as` (human in Stage 1); a path in no tier is human (fail closed). |
| `depends_on` | `tests/golden`: of the golden cases needing this step, the one needing the **fewest other unported steps** decides which tasks must land first (ties broken by name). Without this, the contract's golden gate couldn't pass. Cycles are an error. |
| `acceptance.golden` | `{step, areas}`: the golden areas where the step appears. CI requires every ported case there to pass and at least one checked case to exercise the step. |
| `acceptance.unit` | only when the task map gives the task a `unit: {requirement, cases}`: behaviour golden data can't reach (e.g. a constructor argument upstream never passes). The cases' expected values come from chrono-node; the agent adds one in-file `#[test] fn <case.test>` per case; the `gates` check fails unless each exists in a changed scope file, and `cargo test` runs them. |
| `priority`, `golden_cases` | golden impact: more golden cases need the step → higher priority |

`taskmap.yaml` is validated before anything is written:
- every step of every named configuration (English, German, French, Swedish, Portuguese, Spanish, Japanese) is either `done` or a task
- no duplicate ids, steps or files
- each upstream file exists and declares the class (the step, or the task's `class` where upstream reuses a class name: both `…TimeUnitRelativeFormatParser.ts` files declare `…TimeUnitAgoFormatParser`)
- each Rust file is a single file in a `parsers/` or `refiners/` directory, so it auto-registers and no shared line is edited

## Generated locales (`taskmap.d/`)

Languages onboarded by `harness/onboard/onboard.js` add a fragment, `taskmap.d/<module>.yaml` (generator output, re-rendered in CI; never edited by hand). The script merges it with `taskmap.yaml`:
- a fragment adds tasks only for its own locale (`locale: <module>` on each);
- a **support task** (`kind: support`: `constants.ts`, a locale's shared base) ports one file directly in `src/locales/<module>/`. It has no step and no golden case; its acceptance is either unit cases recorded from chrono-node (`unit`) or, for a base with nothing to record, a `requirement` its dependents' golden cases check. Steps that import it list it in `needs`, which becomes `depends_on`;
- golden facts are **scoped**: hand-mapped tasks see only the hand-scaffolded groups' cases, a generated locale's tasks only its own group's. Generated priorities start at 1000, ranked within the locale. So onboarding a language adds contracts and never changes one (a changed contract would mark in-flight PRs `stale-contract`).

## Fix contracts

Besides the task map, every fix case in `tests/golden/fixes/` (from the intake: `harness/feedback/README.md`) becomes `contracts/<lang>/fix-<hash>.yaml`: scope = the Rust files of the steps chrono-node used for the case, area = the first of those steps' task areas (else `<lang>-fixes`), priority 0, golden step = the fix id, and a `fix: {issue, signature, steps, requirement}` entry the agent follows (add `// factory-fix: <id>` next to the change). Fix cases never change a port task's areas, priority or dependencies. After a fix contract merges, the intake's `link` job runs `issues --plan --only <id>` (no token), and `harness/feedback/intake.js tasks` creates the issue from that plan.

## Issues

`issues --apply` creates or updates one issue per contract, after the contracts PR has merged. Each issue has:
- labels `factory:task`, `tier:*` and `area:*` (**not** `factory:ready`; the owner adds that)
- the hidden marker `<!-- factory-task: <id> -->`, so re-runs update issues instead of duplicating them
- "blocked by" links for `depends_on`

Guards: it needs `FACTORY_SEED_APPLY=yes` and a token, and it refuses to run unless every generated contract is on `main` byte for byte.

## Upstream sync (`upstream.js`)

`.github/workflows/upstream-sync.yml` runs `node upstream.js check` daily: the newest chrono-node release vs `upstream/PINNED.md`. On a new version it files **one** `upstream` issue per version (a hidden `<!-- factory-upstream: vX.Y.Z -->` marker; never twice, even after it's closed) that maps the upstream diff to the port: changed ported steps and their tasks, new and removed steps (task map entries needed), configurations, core and shared bases, and upstream tests with their golden areas. Unported languages are only counted.

Labelling the issue `upstream:bump` (someone with write access) drafts the human-tier bump PR: `upstream.js stage` re-copies the file list in `PINNED.md` from the tag and updates Version and Commit, then the golden generator and this script regenerate `tests/golden/` and `contracts/`. If the task map needs new entries, the contracts are left alone and the PR says so.

Drill: run the workflow by hand with `drill_pinned_tag: v2.10.0` (or `node upstream.js check --pinned-tag v2.10.0` locally): the current release then looks new, and the issue is labelled `drill`. Staging the pinned tag itself (`stage` from its tarball) leaves `upstream/` byte-identical, which checks the copied file list.
