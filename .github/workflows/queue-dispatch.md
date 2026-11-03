---
description: >
  Work-queue dispatcher (step 3). A trusted step stages one dispatch_next request; the queue's
  scheduler picks the Work and launches its worker. The agent only reads and reports.
# Human tier: changes need the owner's review. Experimental: compiled with an unreleased gh-aw
# built from github/gh-aw main @ b03aa4bfd44afc73876dff056e7c712aff6ea5f5 (contains #72955),
# not the v1.0.1 used by the other workflows. Build and compile:
#   git -C gh-aw checkout b03aa4bfd44afc73876dff056e7c712aff6ea5f5 && make -C gh-aw build
#   gh-aw/gh-aw compile queue-dispatch --gh-aw-ref b03aa4bfd44afc73876dff056e7c712aff6ea5f5
on:
  workflow_dispatch:

permissions:
  contents: read
  actions: read
  copilot-requests: none

concurrency:
  group: factory-queue-dispatch
  cancel-in-progress: false

engine:
  id: copilot
  model: claude-haiku-5.5

timeout-minutes: 10
max-ai-credits: 30

network:
  allowed: []

tools:
  work-queue: true

steps:
  - name: Kill switch, then stage the dispatch request (before inference)
    uses: actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3 # v9.0.0
    env:
      FACTORY_ENABLED: ${{ vars.FACTORY_ENABLED }}
    with:
      script: |
        if (process.env.FACTORY_ENABLED !== 'true') return core.setFailed('kill switch: FACTORY_ENABLED is not "true"');
        const path = require('node:path');
        const { stageIntent } = require(path.join(process.env.RUNNER_TEMP, 'gh-aw/actions/work_queue_intents.cjs'));
        const parameters = { pool: 'default', max_claims: 1, max_dispatches: 1 };
        stageIntent(path.join(process.env.RUNNER_TEMP, 'gh-aw/safeoutputs/work-queue/work-queue.intents.jsonl'),
          { version: 3, intent_id: `dispatch:${context.runId}:${context.runAttempt}:default`, kind: 'dispatch_next', parameters });
        core.info(`staged dispatch_next ${JSON.stringify(parameters)}`);

# Trusted, after the agent: the agent's work-queue tools can stage intents too (a dispatcher may
# submit), so keep only the one dispatch request staged above, or fail.
post-steps:
  - name: Keep only the trusted dispatch request
    # always(): the collected file is uploaded even when the agent fails, so filter it then too.
    if: always()
    env:
      WANT: dispatch:${{ github.run_id }}:${{ github.run_attempt }}:default
    run: |
      f=/tmp/gh-aw/work-queue.intents.jsonl
      [ -f "$f" ] || exit 0  # nothing staged (e.g. the kill switch stopped the run): nothing to publish
      # On any filter or validation failure, empty the published file so nothing unfiltered reaches the queue.
      if ! jq -c --arg want "$WANT" 'select(.intent_id == $want and .kind == "dispatch_next")' "$f" > "$f.trusted" \
         || [ "$(wc -l < "$f.trusted")" -ne 1 ]; then
        : > "$f"; rm -f "$f.trusted"
        echo "::error::expected exactly one trusted dispatch request"; exit 1
      fi
      [ "$(wc -l < "$f")" -eq 1 ] || echo "::warning::dropped $(( $(wc -l < "$f") - 1 )) intent(s) the agent staged"
      mv "$f.trusted" "$f"

safe-outputs:
  github-token: ${{ secrets.GITHUB_TOKEN }}
  dispatch-workflow:
    workflows: [queue-probe]
    target-ref: ${{ github.event.repository.default_branch }}
    max: 1
  noop:
  report-failure-as-issue: false
  report-failed-jobs: false
  report-missing-tool:
    create-issue: false
  report-missing-data:
    create-issue: false
  report-incomplete:
    create-issue: false
  threat-detection:
    continue-on-error: false
    report-as-issue: false
    max-ai-credits: 400
---

# Work-queue dispatcher

A trusted step has already staged one `dispatch_next` request. Don't call `work_queue_submit`,
`work_queue_dispatch_next` or `dispatch_workflow`.

Read the queue once through the `work-queue` command in bash (the work-queue tools are only available
this way): `work-queue work_queue_read '{"pool":"default","limit":8}'`. Report what it shows with
`noop`, in one or two sentences. Don't do anything else.
