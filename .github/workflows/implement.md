---
description: >
  Port one chrono-node step to Rust for one factory task. Dispatched by the controller with the
  task id, issue, attempt and pinned contract SHA. Opens at most one PR through the agent App.
# Human tier: changes need the owner's review. Compile with the pinned gh-aw (v0.92.0):
#   gh aw compile implement
on:
  workflow_dispatch:
    inputs:
      task:
        description: "Factory task id, e.g. en/month-name-parser (contracts/<task>.yaml)"
        required: true
        type: string
      issue:
        description: "Task issue number"
        required: true
        type: string
      attempt:
        description: "Attempt number (1 = first implementation)"
        required: true
        type: string
      contract_sha:
        description: "Contract commit SHA pinned by the controller (full 40 hex)"
        required: true
        type: string

# The task in the run name lets the controller's spend collector attribute AIC to tasks
# (per-task budget, budgets.yaml per_task.max_aic). Keep the format.
run-name: "Implement ${{ github.event.inputs.task }} #${{ github.event.inputs.issue }} attempt ${{ github.event.inputs.attempt }}"

permissions:
  contents: read
  issues: read
  pull-requests: read
  # Inference uses the COPILOT_GITHUB_TOKEN PAT (DESIGN §4), not the Actions token.
  copilot-requests: none

# Each dispatch gets its own slot, so admitted tasks (WIP up to 3) run in parallel.
concurrency:
  group: implement-${{ github.run_id }}
  job-discriminator: ${{ github.run_id }}

# Full history: the freshness check reads the contract's last modifying commit.
checkout:
  fetch-depth: 0

engine:
  id: copilot
  # One pinned model, never auto. Placeholder until the owner's week-1 comparison
  # (claude-sonnet-5.5 vs gpt-5.3-codex).
  model: claude-sonnet-5.5

timeout-minutes: 60

# factory policies/budgets.yaml (v1): per_run.implement and per_workflow_per_day.implement.
max-ai-credits: 500
max-daily-ai-credits: 3000

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

# Setup outside the firewall: toolchain, vendored approved crates, offline docs, and the
# chrono-node judge for local comparisons. Everything lands outside the repo or in ignored paths.
steps:
  # Before any inference: fail closed unless the kill switch is on, reject malformed inputs, a
  # gh-aw aw_context (it could redirect the checkout to another PR after this check) and stale
  # dispatches (the contract changed after the controller pinned it). Inputs reach the shell only
  # through env, never interpolated.
  - name: Validate dispatch and contract freshness
    env:
      FACTORY_ENABLED: ${{ vars.FACTORY_ENABLED }}
      AW_CONTEXT: ${{ github.event.inputs.aw_context }}
      TASK: ${{ github.event.inputs.task }}
      ISSUE: ${{ github.event.inputs.issue }}
      ATTEMPT: ${{ github.event.inputs.attempt }}
      CONTRACT_SHA: ${{ github.event.inputs.contract_sha }}
    run: |
      [ "$FACTORY_ENABLED" = "true" ] || { echo "::error::kill switch: FACTORY_ENABLED is not \"true\""; exit 1; }
      [ -z "$AW_CONTEXT" ] || { echo "::error::aw_context must be empty for factory dispatches"; exit 1; }
      [[ "$TASK" =~ ^[a-z0-9-]+(/[a-z0-9-]+)+$ && ${#TASK} -le 100 ]] || { echo "::error::invalid task id"; exit 1; }
      [[ "$ISSUE" =~ ^[1-9][0-9]{0,8}$ && "$ATTEMPT" =~ ^[1-9][0-9]?$ ]] || { echo "::error::invalid issue or attempt"; exit 1; }
      [[ "$CONTRACT_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "::error::contract_sha must be a full 40-hex commit SHA"; exit 1; }
      contract="contracts/${TASK}.yaml"
      [ -f "$contract" ] || { echo "::error::no contract ${contract} on this commit"; exit 1; }
      last=$(git log -1 --format=%H -- "$contract")
      [ "$last" = "$CONTRACT_SHA" ] || { echo "::error::stale dispatch: ${contract} is at ${last}, dispatched with ${CONTRACT_SHA}"; exit 1; }
      echo "contract ${contract} is at ${last} (matches dispatch)"
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
  missing-tool:
    create-issue: false
  missing-data:
    create-issue: false
  report-incomplete:
    create-issue: false
  create-pull-request:
    max: 1
    draft: false
    title-prefix: "[factory] "
    if-no-changes: error
    fallback-as-issue: false
    auto-close-issue: false
    protected-files: blocked
    # Coarse allowlist; the trusted `gates` check enforces the contract's exact scope.
    allowed-files:
      - "src/locales/**"
      - "src/common/parsers/**"
      - "src/common/refiners/**"
  # Only the task issue (validated as a number before inference), never one the agent picks.
  add-comment:
    max: 1
    target: ${{ github.event.inputs.issue }}
  # Strict: a flagged run produces nothing, and no tracking issue carries its text.
  threat-detection:
    continue-on-error: false
    report-as-issue: false
---

# Implement one factory task

You are porting **one step of chrono-node** (a natural-language date parser in TypeScript) to Rust, in this repository.

- Task: `${{ github.event.inputs.task }}`
- Issue: #${{ github.event.inputs.issue }}
- Attempt: ${{ github.event.inputs.attempt }}
- Contract SHA: `${{ github.event.inputs.contract_sha }}`

## Read first

1. The contract: `contracts/${{ github.event.inputs.task }}.yaml`. It is the definition of done. It names the upstream `source` file, the single Rust file you may change (`scope`), and the acceptance checks.
2. `PORTING.md`: the patterns to copy and the traps to avoid. Follow it exactly.
3. The upstream source under `upstream/src/` (pinned; read-only), plus a similar file that is already ported (for example `src/locales/en/parsers/weekday.rs`).

## Do

- Port the upstream step **line by line, keeping its behaviour and quirks**. Create or edit **only** the file in the contract's `scope`. It registers itself through its `UPSTREAM` constant; don't edit any `mod` list, configuration, `Cargo.toml`, tests, golden data, contracts, `harness/`, `upstream/` or `.github/`.
- If you need a crate that isn't already a dependency, stop and explain why in your comment. Don't add it.
- Check your work offline (no network is available; crates are vendored):
  - `cargo fmt` and `cargo clippy --all-targets -- -D warnings`
  - `GOLDEN_AREAS=<the contract's golden areas, comma-separated> GOLDEN_REQUIRE_STEP=<upstream_class> cargo test --test golden -- --nocapture`
  - `cargo test`
  - `cargo build --bin chrono-rs-json && cd harness && node compare/compare.js --seed 42 --phrases 2000`
  - Docs for the crate and its dependencies are in `target/doc/`.

## Output

- Open **one** pull request. Title: `<task>: port <upstream_class>`. The body must end with exactly these three lines (CI checks them):

  ```
  Factory-Task: ${{ github.event.inputs.task }}
  Factory-Attempt: ${{ github.event.inputs.attempt }}
  Contract-SHA: ${{ github.event.inputs.contract_sha }}
  ```

  Above them, briefly say what you ported and paste the summary lines of the golden run (`checked`/`pending`/`failed` and how many checked cases need the step) and of the comparison.
- Add **one** short comment on issue #${{ github.event.inputs.issue }} with the PR link, or with the reason you couldn't open one.
