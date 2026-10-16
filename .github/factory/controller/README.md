# Factory controller v1 (dry-run)

Plain GitHub Actions and TypeScript, with **no AI**. It implements the controller from the factory design
([DESIGN.md](https://github.com/sabbasi3-factory-lab/factory/blob/main/DESIGN.md) §7 and §11), pinned to the
factory version in [`../factory-version`](../factory-version).

**v1 is dry-run only.** It reads GitHub, plans decisions with reason codes, and logs what it *would* do.
It never labels, comments, dispatches, queues, merges or reverts. The only thing it writes is the
append-only audit log on the protected `audit` branch.

## Pipeline (`main.ts`)

1. Read `.github/factory/factory-version` (one line, a full commit SHA).
2. Load `limits`, `budgets`, `tiers` and `cadence` policies from
   `https://raw.githubusercontent.com/sabbasi3-factory-lab/factory/<sha>/policies/<name>.yaml`.
   If anything is missing or malformed, exit non-zero **before** any GitHub call (fail closed).
3. Load the audit log: the last 7 UTC day files at the `audit` head, plus the file named in the head
   commit message. Verify the hash chain. A broken chain or a foreign head commit stops the run.
4. Read a snapshot of GitHub (`github.ts`):
   - open issues (only the `<!-- factory-task: … -->` marker is kept)
   - all PRs through GraphQL (only the `Factory-Task:`, `Contract-SHA:` and `Factory-Attempt:` trailer
     lines are kept)
   - `main` resolved **once** to a commit SHA (`snapshot.main_sha`). The tree, the contract blobs and
     every `commits?path=contracts/<task>.yaml&sha=<main_sha>` lookup use that SHA, so contents and the
     contract commit SHA always come from the same state of main.
   - the contracts the planner needs, each with its blob SHA and **last commit SHA on main**
   - `ci` and `gates` workflow runs. There is no `created>=` cutoff, because re-runs keep their
     original `created_at`. The controller reads the newest 3 pages (×100) of `/actions/runs`, plus one
     `?head_sha=` page for each open PR head (at most 30). It keeps runs updated in the last 24 h, or
     runs for an open PR head. That is at most 33 list calls per poll.
   - when `FACTORY_ENABLED=true`, the org's busy Actions jobs
5. `observe()` turns the snapshot into fact events, and `plan()` (pure) turns it into decisions.
6. The executor logs `[dry-run] would <effect> …` for each decision. It has no GitHub client.
7. Append observed facts, then non-`wait` decisions, then the heartbeat if one is due. Every event is
   deduped by `dedupe_key`.
   - An event that fails validation (`AuditValidationError`: unsafe payload string, bad source id) is
     logged as `skipped invalid audit event (…)` and skipped. Nothing is written for it, and the run goes
     on to the heartbeat.
   - API and chain errors still fail the run.
8. Write a markdown table to `$GITHUB_STEP_SUMMARY`.

## Running it

```sh
cd .github/factory/controller
npm ci
npm test                      # node --test "test/*.test.ts" (Node 24+, native type stripping)
npm run typecheck             # optional: tsc --noEmit
# Whole pipeline on a fixture, in memory, no credentials or network:
FACTORY_ENABLED=true node main.ts --fixture test/fixtures/snapshot.json --print
```

In fixture mode, `now` is the fixture's `fetched_at` (override it with `--now <iso>`). Fixture mode uses the
policy copies in `test/fixtures/policies/` and an in-memory fake of the Git Data API (`fake.ts`). It
prints the canonical lines that would be appended.

In CI (`.github/workflows/controller.yml`), `node main.ts` needs `GH_TOKEN` (the controller App token),
`GITHUB_REPOSITORY`, `GITHUB_RUN_ID`, `GITHUB_EVENT_NAME` and, optionally, `FACTORY_ENABLED`.

## Audit log format (DESIGN §11)

- **Location:** the `audit` branch, files `audit/YYYY/MM/DD.jsonl` (UTC date of the event).
- **One commit per event:** the controller creates a blob, then a tree with `base_tree`, then a commit
  whose parent is the current head, then sends `PATCH refs/heads/audit` with `force: false`.
  - The first event creates the branch as an orphan commit (`POST git/refs`).
  - On a non-fast-forward (409/422), the controller re-reads the branch, re-checks dedupe and retries.
    It retries at most 3 times, then fails.
- **Commit message:** `audit: <type> <event sha> <file path>`. The chain parent is the last line of the
  file named in the head commit's message. Its sha must equal the sha in that message.
- **Event:** canonical JSON on one line, with exactly these fields:

  | field | value |
  |---|---|
  | `version` | `1` |
  | `id` | UUID v4 (`crypto.randomUUID()`) |
  | `type` | event type |
  | `timestamp` | UTC, second precision, e.g. `2026-10-16T12:00:00Z` |
  | `parents` | `["sha256:<previous event sha>"]`, or `[]` for the genesis event |
  | `payload` | object (see below) |
  | `sha` | `"sha256:" + hex(SHA-256(canonical(event without sha)))` |

- **Canonical JSON** (`canonical.ts`, RFC 8785 style):
  - keys are sorted by UTF-16 code units, recursively
  - there is no whitespace
  - numbers and strings are serialized like `JSON.stringify`
  - non-finite numbers, `undefined` and non-plain objects are rejected
- **Every payload** has:
  - `dedupe_key` = `"sha256:" + hex(sha256(type + "|" + sorted source IDs joined by "|"))`
  - `factory_version` (the pinned SHA)
  - `dry_run: true`
- **Payload safety:** payload strings must match `^[A-Za-z0-9._:/#@[\]+-]{0,200}$`. That allows IDs,
  SHAs, logins, enums, task ids and timestamps. Free text (titles, bodies, comments) is rejected at write
  time.
  - Task ids are capped at 100 characters (`MAX_TASK_ID_LENGTH`), so every accepted id passes this check.
  - A longer marker is `invalid`, and a longer `Factory-Task:` trailer is ignored.
- **`verify(lines, expectedFirstParent?)`** (`audit.ts`) recomputes each sha. It also checks:
  - canonical form
  - exact fields
  - the parent chain
  - non-decreasing timestamps

  It returns the first broken index.

### Event types written by v1

| type | source IDs (dedupe) | payload (besides the common fields) |
|---|---|---|
| `pr_opened` | PR node id | `pr`, `head_sha` (head at observation time), `author`, `opened_at` |
| `check_result` | `<run_id>/attempts/<attempt>` | `workflow`, `run_id`, `run_attempt`, `event` (`pull_request`/`pull_request_target`/`merge_group`), `head_sha`, `prs`, `conclusion`, `completed_at`, and `heldout_seed` / `failure_signature` when CI printed them |
| `queued` / `dequeued` | timeline event node id | `pr`, `actor`, `at` |
| `merged` | PR node id | `pr`, `merge_commit_sha`, `merged_at`, `task` |
| `human_action` | review node id | `action: review`, `pr`, `reviewer`, `state`, `submitted_at` (non-bot reviewers only) |
| `heartbeat` | `hour:YYYY-MM-DDTHH` | `hour`, `run_id`, `trigger`, `open_pr_count`, `decision_count`, `factory_enabled` |
| decision types | the planner's `source_ids` + `reason:<reason>` + `effect:<effect>` (a changed reason for the same subject is recorded; an identical retry dedupes) | `reason`, `effect`, and when set: `task`, `issue`, `pr`, `attempt`, `contract_sha`, `run_id`, `failure_signature` |

- **Facts:** the controller observes only facts whose own GitHub timestamp is within the last 24 h. That
  is shorter than the 7 days of loaded history, so a fact is always found by the dedupe check.
- **Merge queue:** queue entries and exits come from PR timeline items `AddedToMergeQueueEvent` and
  `RemovedFromMergeQueueEvent` (GraphQL).
- **Held-out seed:** read from the `checks` job log of each `ci` run
  (`GET /repos/{o}/{r}/actions/jobs/{id}/logs`).
  - It must be an exact line `factory-heldout-seed: <decimal>`, after the Actions timestamp prefix.
  - Lines printed inside a step whose `##[group]Run …` command passes `--seed` are ignored. That step is
    the reproducible contract-seeded comparison, which prints its seed in the same format.
  - Conflicting values are dropped.
  - It is stored as a decimal **string** because it may exceed 2^53.
  - Logs are read once per run attempt. After that, the recorded value is reused.
- **Heartbeat:** written when the newest heartbeat in the loaded log is ≥ 55 minutes old, or missing.
  Its dedupe key is the UTC hour, so two runs in the same hour can't both write one.

## Daily chain verifier (`verify-chain.ts`, `.github/workflows/audit-verify.yml`)

The controller only verifies the last 7 days it loads, so a cut-off tail or a rewritten branch
wouldn't be noticed. Once a day, a separate workflow (no App key, `issues: write` only):

1. Checks out the **whole** `audit` branch and verifies every day file: file names, the right day
   for each event, every sha, and the chain from a **genesis** event (no parent).
2. Checks the log against every earlier **anchor**. An anchor is a comment by
   `github-actions[bot]` on the "Audit chain anchors" issue (label `audit-anchor`), recording
   `{at, events, last_sha, audit_head}`. The log may only grow:
   - each anchored position must still hold the anchored event
   - anchors never shrink
   - an anchor comment that was edited fails
   - a missing branch fails once anything was anchored

   Comments and issues by anyone else are ignored, since anyone can comment on a public repo.
3. On success it appends a new anchor; the comment also emails watchers, a copy outside GitHub.
   On failure it opens (or comments on) one `audit-alert` issue and fails the run.

Alerts and anchors carry only counts, SHAs, paths and dates.

## Planner (`planner.ts`)

`plan(snapshot, policies, env, now)` is pure. Every decision has `dry_run: true`, a stable `reason`, an
`effect` it *would* take, and deterministic `source_ids`.

| type | reason | when | would |
|---|---|---|---|
| `dispatched` | `would_dispatch` | admitted ready task passes every gate | `dispatch_workflow:implement` (attempt 1, `contract_sha` = contract commit SHA) |
| `repair_dispatched` | `ci_failed` | the newest `ci` run on the PR head failed, with a new signature and repairs < `max_repairs` | `dispatch_workflow:repair` |
| `needs_human` | `gates_failed` | the newest `gates` run for the PR head failed (policy: scope, Contract-SHA, identifiers). It is never repaired. | `label:needs-human` |
| `needs_human` | `repeated_signature` | same failure signature seen before | `label:needs-human` |
| `needs_human` | `max_repairs` | repairs ≥ `limits.task.max_repairs` | `label:needs-human` |
| `needs_human` | `missing_failure_signature` | failed run without a `factory-failure-signature:` line (fail closed) | `label:needs-human` |
| `needs_human` | `task_budget_exhausted` | task AIC ≥ `budgets.per_task.max_aic` | `label:needs-human` |
| `needs_human` | `task_timeout` | picked > `max_wall_clock_hours` ago and not merged | `label:needs-human` |
| `stale_contract` | `contract_changed` | PR `Contract-SHA:` isn't a ≥7-hex prefix of the contract's last commit SHA on main | `label:stale-contract` |
| `stale_contract` | `contract_missing` | the PR's contract is gone from main | `label:stale-contract` |
| `blocked` | `missing_contract_sha` | factory PR without `Contract-SHA:` | `label:blocked` |
| `blocked` | `missing_task_marker` | `factory:ready` issue without a single valid marker | `label:blocked` |
| `blocked` | `duplicate_task` | a second open issue for the same task | `label:blocked` |
| `blocked` | `contract_missing` | ready issue with no `contracts/<task>.yaml` on main | `label:blocked` |
| `blocked` | `invalid_contract` | contract can't be parsed or its `id` doesn't match its path | `label:blocked` |
| `budget_alert` | `budget_alert` | factory AIC today ≥ `alert_at_pct` | `alert:owner` |
| `budget_pause` | `budget_pause` | factory AIC today ≥ `pause_at_pct` | `pause_dispatch` |
| `kill_switch` | `kill_switch` | something would be dispatched but `FACTORY_ENABLED` isn't exactly `"true"` | none (one aggregated decision) |
| `wait` | `already_merged`, `deps_not_merged`, `budget_unknown`, `budget_pause`, `busy_jobs_unknown`, `actions_busy`, `wip_full`, `human_queue_full`, `core_area_busy`, `area_locked` | the task is held back this run | nothing (logged, **not** recorded) |

**Admission**

A task is admitted only if all of these are true:

- the issue has `factory:ready`, and doesn't have `needs-human` or `factory:picked`
- it has exactly one valid marker
- the contract is on main and is valid
- every `depends_on` task has a merged PR carrying `Factory-Task: <dep>`

Admitted tasks are sorted by dependency depth, then contract `priority` (lower first), then issue number.

**Gates**

The planner applies these gates in order. Repairs only go through the first group.

1. kill switch
2. budget (unknown or paused)
3. busy jobs (unknown, or `busy + planned × ci.max_jobs_per_pr > 14`)
4. WIP (`wip.start`, clamped to `wip.max`)
5. human queue (> `human_queue.max_items`, human-tier tasks only)
6. core area (`wip.core_area`)
7. area lock (same contract `area`, or overlapping `scope`)

**Tiers**

A task's tier is the strictest of the contract's `tier` and each scope path's tier from `tiers.yaml`.
Unknown paths count as `human`. Auto-strict paths use `start_as` (currently `human`).

**Core tasks**

A core task has a scope path under the auto-strict globs (`src/core/**` etc.).

**Which CI runs count**

The planner picks the newest run for the PR head: the highest `run_id`, then `run_attempt`.

- **Unfinished runs:** if the newest run is still queued or running, the controller waits. An older
  failure is not acted on.
- **`ci` runs** (`pull_request`; `head_sha` is the PR head):
  - a failure feeds the Evergreen repair path
  - `failure` / `timed_out` / `startup_failure` count as failures
- **`gates` runs** (`pull_request_target`):
  - `head_sha` is the main tip, so the PR head comes from the run's `pull_requests[].head.sha`
    (`candidate_sha`)
  - a failure is a policy decision, so it goes to `needs_human/gates_failed` and is never repaired
  - a gates failure takes precedence over a `ci` failure on the same head
- **`merge_group` runs** are recorded as `check_result` but never trigger repairs.

**One terminal decision per task per run**

Task timeouts are evaluated first. A task escalated to `needs_human` in this run, for any reason, gets
no other decision in that run: no repair, no contract decision and no second escalation.

**In flight**

A task is in flight if it has an open PR with `Factory-Task:`, its issue has `factory:picked`, or a
non-dry-run `picked`/`dispatched` event exists.

**History**

History comes only from **non-dry-run** audit events: picked time, repairs, signatures and spend. So
v1's own dry-run decisions never count as real work.

## How dry-run is enforced

- `executor.ts` exports `DRY_RUN = true as const`. It is not an input or an env var. `run()` and
  `execute()` throw if it is not `true`.
- The executor has **no GitHub client**. It only formats `would …` log lines.
- The real client (`github.ts`) calls `assertAllowedRequest()` before every request. It refuses
  everything except:
  - GETs
  - read-only GraphQL `query`
  - `POST git/blobs|trees|commits`
  - `PATCH git/refs/heads/audit` with `force: false`
  - `POST git/refs` for `refs/heads/audit`
- `test/main.test.ts` runs the whole pipeline against a recording fake. It asserts that every
  non-GET call is one of those audit-branch Git Data writes.
- The workflow's `GITHUB_TOKEN` is read-only.
- The App token is requested with only `contents: write` plus read scopes. It is minted after
  `npm ci` and `npm test`.
- The workflow uses `pull_request_target` and always checks out `main`, so PR code never runs with the
  App token.

## Files

| file | purpose |
|---|---|
| `types.ts` | shared types |
| `canonical.ts` | canonical JSON |
| `audit.ts` | event construction, dedupe keys, hash chain, `verify`, the `audit` branch writer |
| `tasks.ts` | marker/trailer/contract parsing, globs, tiers, area locks |
| `planner.ts` | pure planner |
| `observe.ts` | snapshot → observed fact events |
| `history.ts` | task history and today's spend from non-dry-run audit events |
| `verify-chain.ts` | daily whole-log chain verifier with external anchors (its own workflow) |
| `heartbeat.ts` | heartbeat due check and hour-bucket dedupe |
| `executor.ts` | dry-run executor (logs only), decision → event |
| `github.ts` | fetch client with write guard, pagination, GraphQL, snapshot reader, CI log parsing |
| `policies.ts` | pinned policy loader and validation |
| `fake.ts` | in-memory GitHub fake (tests and `--fixture`) |
| `main.ts` | entrypoint |
