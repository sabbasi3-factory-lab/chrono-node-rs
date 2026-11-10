---
description: >
  Temporary work-queue probe (step 3, PR-delivery check). A queue worker that opens one PR through
  the agent App, to prove gh-aw records a verified Result for it. Removed after the check.
# Human tier: changes need the owner's review. Experimental: compiled with an unreleased gh-aw
# built from github/gh-aw main @ b03aa4bfd44afc73876dff056e7c712aff6ea5f5 (contains #72955),
# not the v1.0.1 used by the other workflows. Build and compile:
#   git -C gh-aw checkout b03aa4bfd44afc73876dff056e7c712aff6ea5f5 && make -C gh-aw build
#   gh-aw/gh-aw compile queue-probe --gh-aw-ref b03aa4bfd44afc73876dff056e7c712aff6ea5f5
on:
  workflow_dispatch:

permissions:
  contents: read
  # Inference uses the COPILOT_GITHUB_TOKEN PAT (DESIGN §4), not the Actions token.
  copilot-requests: none

engine:
  id: copilot
  # The implement worker's model (the real worker's behaviour is what this probe checks).
  model: claude-sonnet-5.5

timeout-minutes: 15
# Temporary (v1.2.2 probe): gh-aw's work-queue loggers print only counts and flags; this shows
# which delivery check fails. Remove after the probe.
env:
  DEBUG: "work-queue:*"
max-ai-credits: 50

network:
  allowed: []

tools:
  edit:
  # gh-aw adds git add/checkout/commit and the `work-queue` CLI wrapper (the only way to reach the
  # work-queue tools: a direct MCP call is denied in non-interactive Copilot CLI).
  bash: ["echo", "cat", "ls", "mkdir"]
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

Process only the original claims in `work_queue_assignment`. There is one Claim, with handle `h1`.

Run each command separately (no `&&` chains):

1. Create the file `drill/queue-probe/<the Claim's work.task.probe value>.txt` containing one line: `queue probe`.
2. `git checkout -b queue-probe/<probe value>`, then `git add` that file, then `git commit -m "Add work-queue delivery check file <probe value>"`.
3. Open one pull request with `create_pull_request` on that branch, with `claim_handle` `h1`. Title: `Add work-queue delivery check file <probe value>`. Body: `Adds one file to verify that the work queue records this pull request as delivered. It will be closed without merging.`
4. Finish the Claim through the `work-queue` command in bash (the work-queue tools are only available this way):
   `work-queue work_queue_claim_finish '{"claim_handle":"h1","outcome":"completed"}'`

If you can't open the pull request, run `work-queue work_queue_claim_finish '{"claim_handle":"h1","outcome":"cancelled"}'` instead. Don't do anything else.
