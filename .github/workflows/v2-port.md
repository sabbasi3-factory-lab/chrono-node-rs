---
description: >
  Factory v2 (docs/factory-v2.md): port one whole chrono-node language to Rust in one run. Dispatched
  by v2-router.yml with the language, its issue and the pinned contracts commit. Opens at most one PR
  through the agent App, with auto-merge on.
# Human tier: changes need the owner's review. Compile with the pinned gh-aw (v1.0.1):
#   gh aw compile v2-port
on:
  workflow_dispatch:
    inputs:
      unit:
        description: "Language code, e.g. it (contracts/<unit>/, listed in .github/factory/v2.yaml)"
        required: true
        type: string
      issue:
        description: "The language's factory-v2 issue number"
        required: true
        type: string
      contract_sha:
        description: "Last commit to contracts/<unit>/ on main, pinned by the router (full 40 hex)"
        required: true
        type: string

# The unit and issue in the run name let the router's budget gate and gh aw logs attribute runs. Keep the format.
run-name: "Port ${{ github.event.inputs.unit }} #${{ github.event.inputs.issue }}"

permissions:
  contents: read
  issues: read
  pull-requests: read
  # Inference uses the COPILOT_GITHUB_TOKEN PAT (DESIGN §4), not the Actions token.
  copilot-requests: none

concurrency:
  group: v2-port-${{ github.event.inputs.unit }}
  job-discriminator: ${{ github.event.inputs.unit }}

# Full history: the freshness check reads the contracts' last modifying commit.
checkout:
  fetch-depth: 0

engine:
  id: copilot
  # The implementer's pinned model (implement.md), never auto.
  model: claude-sonnet-5.5

# A whole language (about 15-20 steps) in one run.
timeout-minutes: 90

# Per run: factory policies/budgets.yaml per_run.implement (v2.yaml caps.port). Per day: v2's own cap.
max-ai-credits: 500
max-daily-ai-credits: 1000

# Blocked by default: no ecosystems (no crates.io, docs.rs, npm or web). Inference goes through
# gh-aw's API proxy. Crates come from the vendored copy prepared in `steps:` below.
network:
  allowed: []

tools:
  github:
    toolsets: [repos, issues, pull_requests]
    allowed-repos: [sabbasi3-factory-lab/chrono-node-rs]
    # Only content from users with write access reaches the agent (DESIGN §13).
    min-integrity: approved
    read-only: true
  edit:
  bash:
    - "cargo:*"
    - "git:*"
    - "node:*"
    - "ls"
    - "cat"
    - "head"
    - "tail"
    - "grep"
    - "find"
    - "wc"
    - "sed"
    - "diff"
    - "sort"
    - "echo"
    - "pwd"

# Setup outside the firewall, as in implement.md. Inputs reach the shell only through env.
steps:
  # Before any inference: fail closed unless the kill switch is on, the language is a v2 language, the
  # contracts are still at the pinned commit, and every contract is auto tier (auto-strict needs the
  # reviewer, which v2 doesn't dispatch: those stay on v1).
  - name: Validate dispatch, language and contracts
    env:
      FACTORY_ENABLED: ${{ vars.FACTORY_ENABLED }}
      AW_CONTEXT: ${{ github.event.inputs.aw_context }}
      UNIT: ${{ github.event.inputs.unit }}
      ISSUE: ${{ github.event.inputs.issue }}
      CONTRACT_SHA: ${{ github.event.inputs.contract_sha }}
    run: |
      [ "$FACTORY_ENABLED" = "true" ] || { echo "::error::kill switch: FACTORY_ENABLED is not \"true\""; exit 1; }
      [ -z "$AW_CONTEXT" ] || { echo "::error::aw_context must be empty for factory dispatches"; exit 1; }
      [[ "$UNIT" =~ ^[a-z]{2}(-[a-z]+)?$ ]] || { echo "::error::invalid unit"; exit 1; }
      [[ "$ISSUE" =~ ^[1-9][0-9]{0,8}$ ]] || { echo "::error::invalid issue"; exit 1; }
      [[ "$CONTRACT_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "::error::contract_sha must be a full 40-hex commit SHA"; exit 1; }
      yq -e ".languages | contains([\"${UNIT}\"])" .github/factory/v2.yaml > /dev/null || { echo "::error::${UNIT} is not in .github/factory/v2.yaml languages"; exit 1; }
      ls contracts/"$UNIT"/*.yaml > /dev/null || { echo "::error::no contracts/${UNIT}/"; exit 1; }
      last=$(git log -1 --format=%H -- "contracts/${UNIT}/")
      [ "$last" = "$CONTRACT_SHA" ] || { echo "::error::stale dispatch: contracts/${UNIT}/ is at ${last}, dispatched with ${CONTRACT_SHA}"; exit 1; }
      tiers=$(yq -r '.tier' contracts/"$UNIT"/*.yaml | sort -u)
      [ "$tiers" = "auto" ] || { echo "::error::contracts/${UNIT}/ has tiers other than auto ($(echo $tiers)): auto-strict stays on v1"; exit 1; }
      echo "contracts/${UNIT}/ ($(ls contracts/"$UNIT"/*.yaml | wc -l | tr -d ' ') contracts) is at ${last} (matches dispatch)"
  - name: Rust toolchain (rust-toolchain.toml)
    run: rustup toolchain install && rustc --version
  # The vendor tree lives in the workspace's gitignored target/ (always visible inside the agent
  # sandbox, never part of a PR); the source replacement goes in $CARGO_HOME, outside the repo.
  - name: Vendor approved crates (offline cargo for the agent)
    run: |
      vendor="$GITHUB_WORKSPACE/target/factory-vendor"
      mkdir -p "$vendor"
      cargo vendor --locked --versioned-dirs "$vendor" > "$RUNNER_TEMP/vendor.toml"
      cargo_home="${CARGO_HOME:-$HOME/.cargo}"
      mkdir -p "$cargo_home"
      { cat "$RUNNER_TEMP/vendor.toml"; printf '\n[net]\noffline = true\n'; } > "$cargo_home/config.toml"
      cargo build --locked --all-targets --offline
  - name: Offline docs for the crate and its dependencies
    run: cargo doc --locked && echo "docs in target/doc"
  - name: chrono-node judge (golden data + comparison harness)
    working-directory: harness
    run: npm ci --ignore-scripts --no-audit --no-fund && npm run build:upstream
  # The language's contracts as one table for the agent (data from main, under the gitignored target/).
  - name: Contract table for the agent
    env:
      UNIT: ${{ github.event.inputs.unit }}
    run: |
      out="$GITHUB_WORKSPACE/target/factory-v2"
      mkdir -p "$out"
      for f in contracts/"$UNIT"/*.yaml; do
        yq -o=json '{"id": .id, "class": .upstream_class, "area": .area, "scope": .scope, "depends_on": .depends_on,
          "golden_step": ([.acceptance[] | select(has("golden")) | .golden.step] | .[0]),
          "golden_areas": ([.acceptance[] | select(has("golden")) | .golden.areas] | .[0]),
          "unit_tests": ([.acceptance[] | select(has("unit")) | .unit.cases[].test])}' "$f"
      done | jq -s . > "$out/contracts.json"
      jq -r '.[] | "\(.id)\t\(.scope | join(","))"' "$out/contracts.json"

# Yes/no checks on every run, judged from the agent's output (its PR body), not from the diff;
# the trusted gates job checks the diff itself. Advisory only: evals never gate merges.
evals:
  # A different family than the agent (claude-sonnet-5.5), as in implement.md.
  model: gpt-6.1-sol
  questions:
    - id: upstream_cited
      question: >-
        Does the pull request body's "Upstream evidence" section cite an upstream file and line, or a
        golden case id, for the behaviours it states?
    - id: tests_not_weakened
      question: >-
        Does the pull request body's "Tests" section state that no test, assertion or golden case was
        removed, skipped, ignored or loosened?

safe-outputs:
  github-app:
    client-id: ${{ vars.FACTORY_AGENT_APP_ID }}
    private-key: ${{ secrets.FACTORY_AGENT_PRIVATE_KEY }}
    owner: sabbasi3-factory-lab
    repositories: [chrono-node-rs]
  # Strict detection must also cover failure reporting: no automatic failure issues/comments
  # carrying agent-supplied text from a run whose detection didn't succeed.
  report-failure-as-issue: false
  report-failed-jobs: false
  report-missing-tool:
    create-issue: false
  report-missing-data:
    create-issue: false
  report-incomplete:
    create-issue: false
  create-pull-request:
    max: 1
    draft: false
    title-prefix: "[factory] "
    # v2-router.yml recognises v2 PRs by this prefix (then checks the author and trailers).
    branch-prefix: "factory-v2/"
    # GitHub queues and merges the PR once the required checks (checks, gates, CodeQL) pass.
    auto-merge: true
    if-no-changes: error
    fallback-as-issue: false
    auto-close-issue: false
    protected-files: blocked
    # Coarse allowlist; the trusted `gates` check enforces the union of the language's contract scopes.
    allowed-files:
      - "src/locales/**"
    # The trailers gates checks, and the issue to close on merge: from the dispatch, not the agent.
    body-footer: |

      Closes #${{ github.event.inputs.issue }}

      Factory-Unit: ${{ github.event.inputs.unit }}
      Contract-SHA: ${{ github.event.inputs.contract_sha }}
  # A dependency request for the steward (agents can't edit Cargo.toml; DESIGN §9), as in implement.md.
  create-issue:
    max: 1
    title-prefix: "[dependency-request] "
    labels: [dependency-request]
  # Only the language's issue (validated as a number before inference), never one the agent picks.
  add-comment:
    max: 1
    target: ${{ github.event.inputs.issue }}
  # Strict: a flagged run produces nothing, and no tracking issue carries its text.
  threat-detection:
    continue-on-error: false
    report-as-issue: false
    # Pinned (budgets.yaml per_run.threat_detection; v2.yaml caps.threat_detection).
    max-ai-credits: 400
---

# Port one language (factory v2)

You are porting **a whole chrono-node locale** (a natural-language date parser in TypeScript) to Rust, in this repository: every step (parser, refiner, constants) of `upstream/src/locales/${{ github.event.inputs.unit }}/`, in one pull request.

- Language: `${{ github.event.inputs.unit }}`
- Issue: #${{ github.event.inputs.issue }}

## Read first

1. `target/factory-v2/contracts.json`: one entry per contract in `contracts/${{ github.event.inputs.unit }}/`, with its upstream class, the Rust file(s) you may change (`scope`), its dependencies, and its acceptance (golden step and areas, or unit test names). Each contract `contracts/<id>.yaml` is the definition of done for its step.
2. `PORTING.md`: the patterns to copy and the traps to avoid. Follow it exactly.
3. The upstream sources under `upstream/src/` (pinned; read-only), and a language that is already ported for the same shapes (for example `src/locales/nl/` or `src/locales/vi/`).

## Do

- Port **every** contract, in dependency order (constants first, refiners last). For each, port the upstream step **line by line, keeping its behaviour and quirks**, and create or edit **only** the files in its `scope`. Each step registers itself through its `UPSTREAM` constant; don't edit any `mod` list, configuration, `Cargo.toml`, tests outside the scope files, golden data, contracts, `harness/`, `upstream/` or `.github/`. A contract with `unit_tests` needs those `#[test]` functions in its scope file, each asserting upstream's values.
- After each step, check it on its own: `GOLDEN_AREAS=<its golden_areas, comma-separated> GOLDEN_REQUIRE_STEP=<its golden_step> cargo test --test golden -- --nocapture` (or `cargo test --lib` for a unit-test contract).
- When every step is ported, check the whole language offline (no network is available; crates are vendored):
  - `cargo fmt` and `cargo clippy --all-targets -- -D warnings`
  - `cargo test`
  - `cargo build --bin chrono-rs-json`, then in `harness/`: `node golden/frontier.js --rust ../target/debug/chrono-rs-json --complete` (every step's own output matches chrono-node on every case, and no case is left pending) and `node compare/compare.js --seed 42 --phrases 10000 --rust ../target/debug/chrono-rs-json` (no mismatch).
  - Docs for the crate and its dependencies are in `target/doc/`.
- If you need a crate that isn't already a dependency, don't add it: you can't edit `Cargo.toml`. File **one** dependency request with `create_issue` (title `<crate> <version>`; body headings `### Crate`, `### Version`, `### Kind`, `### Reason`, `### Task` with `${{ github.event.inputs.unit }}`), do what you can without it, and say so in your comment.

## Output

- Open **one** pull request with every step. Title: `${{ github.event.inputs.unit }}: port the ${{ github.event.inputs.unit }} locale`. Don't write `Factory-Task:`, `Factory-Unit:`, `Contract-SHA:` or `Closes` lines: they are added for you. Use these sections, in this order:
  - `## Summary`: what you ported (one line per contract), plus the summary lines of the golden run (`checked`/`pending`/`failed`), the frontier and the comparison.
  - `## Upstream evidence`: for the behaviours you state, the upstream file and line (`upstream/src/...:NN` or `upstream/test/...:NN`) or the golden case id.
  - `## Tests`: whether any test, assertion or golden case was removed, skipped, ignored or loosened (it must not be).
  - `## PORTING patterns`: the PORTING.md patterns the port follows.
- Add **one** short comment on issue #${{ github.event.inputs.issue }} with the PR link, or with the reason you couldn't open one.
