---
description: >
  Work-queue dispatcher (step 3). A trusted step stages one dispatch_next request; the queue's
  scheduler picks the Work and launches its worker. The agent only reads and reports.
# Human tier: changes need the owner's review. Compile with the pinned gh-aw (v1.0.1):
#   gh aw compile queue-dispatch
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

Call `work_queue_read` once with `{"pool":"default","limit":8}` and report what it shows with
`noop`, in one or two sentences. Don't do anything else.
