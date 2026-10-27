# seed-backlog

The seed script (DESIGN §6). It's deterministic, uses no AI, and needs no network except reading `policies/tiers.yaml` from the factory repo at the pinned factory version.

```sh
cd scripts/seed-backlog && npm ci
node seed.js contracts           # write contracts/<id>.yaml
node seed.js contracts --check   # fail if contracts/ is stale
node seed.js issues --plan       # print the issues the contracts would become (no writes)
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
| `acceptance.unit` | only when the task map gives the task a `unit: {requirement, cases}`: behaviour golden data can't reach (e.g. a constructor argument upstream never passes). The cases' expected values come from chrono-node; the agent adds one in-file `#[cfg(test)]` test per case, which `cargo test` runs in CI, and the reviewer checks they're there. |
| `priority`, `golden_cases` | golden impact: more golden cases need the step → higher priority |

`taskmap.yaml` is validated before anything is written:
- every step of the four English configurations is either `done` or a task
- no duplicate ids, steps or files
- each upstream file exists and declares the class
- each Rust file is a single file in a `parsers/` or `refiners/` directory, so it auto-registers and no shared line is edited

## Issues (not run yet)

`issues --apply` creates or updates one issue per contract, after the contracts PR has merged. Each issue has:
- labels `factory:task`, `tier:*` and `area:*` (**not** `factory:ready`; the owner adds that)
- the hidden marker `<!-- factory-task: <id> -->`, so re-runs update issues instead of duplicating them
- "blocked by" links for `depends_on`

Guards: it needs `FACTORY_SEED_APPLY=yes` and a token, and it refuses to run unless every generated contract is on `main` byte for byte.
