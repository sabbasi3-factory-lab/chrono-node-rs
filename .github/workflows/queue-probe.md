---
description: >
  Temporary work-queue probe (step 3, PR-delivery check). A queue worker that opens one PR through
  the agent App, to prove gh-aw records a verified Result for it. Removed after the check.
# Human tier: changes need the owner's review. Compile with the pinned gh-aw (v1.0.1):
#   gh aw compile queue-probe
on:
  workflow_dispatch:

permissions:
  contents: read
  # Inference uses the COPILOT_GITHUB_TOKEN PAT (DESIGN §4), not the Actions token.
  copilot-requests: none

engine:
  id: copilot
  # The implement worker's model: claude-haiku-5.5 skipped work_queue_claim_finish in two attempts.
  model: claude-sonnet-5.5

timeout-minutes: 15
max-ai-credits: 50

network:
  allowed: []

tools:
  edit:
  bash: ["echo", "cat", "ls", "mkdir"]  # no git: create_pull_request picks up the file change itself
  work-queue:
    worker: true
    require-assignment: true

steps:
  - name: Kill switch (before inference)
    env:
      FACTORY_ENABLED: ${{ vars.FACTORY_ENABLED }}
    run: '[ "$FACTORY_ENABLED" = "true" ] || { echo "::error::kill switch: FACTORY_ENABLED is not \"true\""; exit 1; }'

safe-outputs:
  # Queue controls use the built-in token; only the PR goes through the agent App (which has no
  # Actions write, and needs none).
  github-token: ${{ secrets.GITHUB_TOKEN }}
  report-failure-as-issue: false
  report-failed-jobs: false
  report-missing-tool:
    create-issue: false
  report-missing-data:
    create-issue: false
  report-incomplete:
    create-issue: false
  create-pull-request:
    github-app:
      client-id: ${{ vars.FACTORY_AGENT_APP_ID }}
      private-key: ${{ secrets.FACTORY_AGENT_PRIVATE_KEY }}
      owner: sabbasi3-factory-lab
      repositories: [chrono-node-rs]
    max: 1
    draft: true
    title-prefix: "[queue-probe] "
    if-no-changes: error
    fallback-as-issue: false
    auto-close-issue: false
    protected-files: blocked
    allowed-files:
      - "drill/queue-probe/**"
  threat-detection:
    continue-on-error: false
    report-as-issue: false
    max-ai-credits: 400
---

# Work-queue probe worker

Process only the original claims in `work_queue_assignment`. There is one Claim.

1. Create the file `drill/queue-probe/<the Claim's work.task.probe value>.txt` containing one line: `queue probe`. Don't commit; `create_pull_request` picks up the change.
2. Open one pull request with `create_pull_request`, passing the Claim's original handle as `claim_handle`. Title: `Add work-queue delivery check file <the same probe value>`. Body: `Adds one file to verify that the work queue records this pull request as delivered. It will be closed without merging.`
3. Call `work_queue_claim_finish` with that `claim_handle` and outcome `"completed"`.

If you can't do this, call `report_incomplete` with the reason. Don't do anything else.
