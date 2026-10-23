# Factory controller

Plain GitHub Actions and TypeScript, with **no AI**. It implements the controller from the factory design
([DESIGN.md](https://github.com/sabbasi3-factory-lab/factory/blob/main/DESIGN.md) §7 and §11), pinned to the
factory version in [`../factory-version`](../factory-version).

**Dry-run unless `FACTORY_ENABLED` is exactly `"true"`.** In dry-run it reads GitHub, plans decisions
with reason codes and logs what it *would* do; the only thing it writes is the append-only audit log
on the protected `audit` branch. In **live** mode it also takes a short, fixed list of effects (below).
It never queues, merges, closes or reverts anything, and never removes a label, in either mode.

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
6. Dry-run: the executor logs `[dry-run] would <effect> …` for each decision (no GitHub client). Live: it
   takes each decision's effect once (see below), and records it right after.
7. Append observed facts, then non-`wait` decisions, then the heartbeat if one is due. Every event is
   deduped by `dedupe_key`.
   - An event that fails validation (`AuditValidationError`: unsafe payload string, bad source id) is
     logged as `skipped invalid audit event (…)` and skipped. Nothing is written for it, and the run goes
     on to the heartbeat.
   - API and chain errors still fail the run.
8. Sync the Project #1 "Factory status" field (`project.ts`, see **Project status** below), then write
   the heartbeat if one is due.
9. Write a markdown table to `$GITHUB_STEP_SUMMARY`.

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
| `check_result` | `<run_id>/attempts/<attempt>` | `workflow`, `run_id`, `run_attempt`, `event` (`pull_request`/`pull_request_target`/`merge_group`), `head_sha`, `prs`, `conclusion`, `completed_at`, and `heldout_seed` / `failure_signature` / `full_regression` when known |
| `queued` / `dequeued` | timeline event node id | `pr`, `actor`, `at` |
| `merged` | PR node id | `pr`, `merge_commit_sha`, `merged_at`, `task` |
| `human_action` | review node id | `action: review`, `pr`, `reviewer`, `state`, `submitted_at` (non-bot reviewers only) |
| `heartbeat` | `hour:YYYY-MM-DDTHH` | `hour`, `run_id`, `trigger`, `open_pr_count`, `decision_count`, `factory_enabled` |
| decision types | the planner's `source_ids` + `reason:<reason>` + `effect:<effect>` (a changed reason for the same subject is recorded; an identical retry dedupes) | `reason`, `effect`, and when set: `task`, `issue`, `pr`, `attempt`, `contract_sha`, `run_id`, `failure_signature` |

- **Facts:** the controller observes only facts whose own GitHub timestamp is within the last 24 h. That
  is shorter than the 7 days of loaded history, so a fact is always found by the dedupe check.
- **Merge queue:** queue entries and exits come from PR timeline items `AddedToMergeQueueEvent` and
  `RemovedFromMergeQueueEvent` (GraphQL).
- **Held-out seed (commit–reveal, trusted):** the `checks` job runs PR code, so no line it prints after
  that code starts is trusted on its own.
  - **Only changes that leave `.github/` alone.** A `pull_request` run executes the PR's (merged) copy
    of the workflow, so a change to the workflow, or anything it could use, could forge the record. The
    controller asks the compare API for the change under test (`main...<run head>`: the PR's own
    changes since its merge base). If any file, or either side of a rename, is under `.github/`, or the
    list can't be checked (error, 300+ files), it records **no** seed and **no** signature and doesn't
    read the log. Then `needs_human/missing_heldout_seed` applies.
  - The job's **first** step (`Held-out seed commitment (trusted, before any PR code)`) runs before
    checkout. It prints only `factory-heldout-commit: <sha256("<salt>:<seed>")>` and writes the seed
    and salt to private files. Later steps read them into non-exported shell variables, so they're never
    in a step header or a child process environment before the reveal.
  - After the run, a final step reveals them: `factory-heldout-seed: <n>` and `factory-heldout-salt: <hex>`.
  - The controller records a seed only if the first step really is that step and succeeded (jobs API),
    exactly one commitment line exists and it's inside the first `##[group]Run` section, no commitment
    line appears anywhere else, and exactly one revealed seed/salt pair hashes to it. Otherwise the
    seed is `null`.
  - It is stored as a decimal **string**. Logs are read once per run attempt; then the recorded value is reused.
  - **No seed ⇒ a human looks.** A factory PR whose newest `ci` run finished `success` or `failure`
    without a trusted seed (missing, forged, ambiguous or unrevealed commitment, or a `.github/` change)
    goes to `needs_human/missing_heldout_seed`, whatever the result.
  - **What it proves, and what it doesn't.** Commit–reveal proves *which* seed the trusted first step
    generated, and that the recorded seed wasn't chosen by PR code. It does **not** prove the comparison
    really ran with that seed, or honestly: the `checks` job runs PR code, which can read files on the
    runner and change later steps. The trusted verdicts stay with `gates` (scope, contract, identifiers,
    deny) and with a human review.
- **Failure signature (trusted; only when the change leaves `.github/` alone; coarse, per step):** derived from the runner-reported step results of the `checks` job
  (jobs API), never from log text: `step:<slug of the first failed step>`, or `job:<conclusion>` when the
  job failed without a failed step. It is coarser than a per-case signature (two different golden
  failures in one step share a signature), which errs towards `needs_human`.
- **Heartbeat:** written when the newest heartbeat in the loaded log is ≥ 55 minutes old, or missing.
  Its dedupe key is the UTC hour, so two runs in the same hour can't both write one.

## Planner (`planner.ts`)

`plan(snapshot, policies, env, now)` is pure. Every decision has `dry_run: true`, a stable `reason`, an
`effect` it *would* take, and deterministic `source_ids`.

| type | reason | when | would |
|---|---|---|---|
| `auto_merge` | `auto_merge_ready` | a green auto-tier agent PR, or an auto-strict one the reviewer agent passed (see **Merge stage**) | `enqueue_merge` |
| `review_dispatched` | `review_needed` | an auto-strict PR that meets every merge condition and has no review for its head yet; gated like a repair (kill switch, budget, Actions load) | `dispatch_workflow:review` |
| `needs_human` | `full_regression_missing` | an auto-strict PR whose newest `ci` run passed without a successful full-regression step (`FULL_REGRESSION_STEP`: skipped, missing or untrusted); checked before any review | `label:needs-human` |
| `needs_human` | `review_objected` | the reviewer App's `factory-review` check on this head finished with anything but `success` | `label:needs-human` |
| `needs_human` | `review_contract_changed` | this head was reviewed, but against another (or an unknown) contract version than the current one; no second review is sent automatically | `label:needs-human` |
| `needs_human` | `review_timeout` | no reviewer verdict on this head within 60 minutes of the dispatch (the run failed, was flagged by detection, or posted nothing) | `label:needs-human` |
| `wait` | `review_pending` | the review was dispatched for this head and its verdict isn't in yet | nothing (logged, **not** recorded) |
| `task_done` | `task_merged` | an open issue with a valid task marker whose task has a merged PR (the first one, `pr`). Planned on every poll while the issue is open; gated only by the kill switch (no escalation holds it back). A leftover open PR for a task that's already merged gets no decision at all | `close_task` |
| `needs_human` | `merge_queue_rejected` | the PR left the merge queue without merging after its head went green; never re-queued automatically | `label:needs-human` |
| `wait` | `merge_not_ready` | an auto-tier PR with green checks but an unmet merge condition (named in `source_ids` as `blocker:<why>`) | nothing (logged, **not** recorded) |
| `dispatched` | `would_dispatch` | admitted ready task passes every gate | `dispatch_workflow:implement` (attempt 1, `contract_sha` = contract commit SHA) |
| `repair_dispatched` | `ci_failed` | the newest `ci` run on the PR head failed, with a new signature and repairs < `max_repairs` | `dispatch_workflow:repair` |
| `needs_human` | `gates_failed` | the newest `gates` run for the PR head failed (policy: scope, Contract-SHA, identifiers). It is never repaired. | `label:needs-human` |
| `needs_human` | `repeated_signature` | same failure signature seen before. Signatures are **per step** (coarse): two different failures in one step count as a repeat | `label:needs-human` |
| `needs_human` | `max_repairs` | repairs ≥ `limits.task.max_repairs` | `label:needs-human` |
| `needs_human` | `missing_heldout_seed` | the newest `ci` run on the PR head finished (`success`/`failure`) without a trusted held-out seed (see "Held-out seed" below); checked before any repair | `label:needs-human` |
| `needs_human` | `missing_failure_signature` | failed run whose signature can't be derived from the `checks` job's step results (fail closed) | `label:needs-human` |
| `needs_human` | `task_budget_exhausted` | task AIC ≥ `budgets.per_task.max_aic` | `label:needs-human` |
| `needs_human` | `task_timeout` | picked > `max_wall_clock_hours` ago and not merged | `label:needs-human` |
| `needs_human` | `pick_time_unknown` | issue has `factory:picked` but no pick time in the history window, so it could never time out (fail closed) | `label:needs-human` |
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
| `wait` | `gates_pending` | a `ci` failure, but the newest `gates` run on the head is missing, unfinished or not `success`: nothing is repaired until gates pass | nothing (logged, **not** recorded) |
| `wait` | `check_runs_incomplete` | the PR head is beyond `MAX_HEAD_LOOKUPS` (30) open PRs, so its newest runs may be missing | nothing (logged, **not** recorded) |
| `wait` | `already_merged`, `deps_not_merged`, `budget_unknown`, `budget_pause`, `busy_jobs_unknown`, `actions_busy`, `wip_full`, `human_queue_full`, `core_area_busy`, `area_locked` | the task is held back this run | nothing (logged, **not** recorded) |

**Merge stage**

When the newest `ci` **and** `gates` runs on a factory PR's current head are both `success`, the
controller puts the PR in the merge queue (`enqueue_merge`), but only if every condition holds:
- the task is **`tier: auto`** and not core, or **`auto-strict`** once `tiers.yaml` no longer says
  `start_as: human` (until then no auto-strict or core task is merged automatically, whether it's
  auto-strict by its paths or its contract). Never human.
- the author is the agent App, the PR isn't a draft, and GitHub says it's `MERGEABLE`
- `Contract-SHA:` equals the contract's commit SHA **exactly** (full 40 hex)
- the task issue has `factory:picked`, and neither the issue nor the PR has `needs-human`
- the `ci` run has a trusted held-out seed
- it isn't already in the queue

It's gated only by the kill switch (`FACTORY_ENABLED`); merging spends no AI credits. Reviews aren't
waited for: a Copilot review is a signal, not a gate. The merge queue then runs `checks` and `gates`
on the merge group, and GitHub merges. The controller never merges directly. `queued`, `dequeued` and
`merged` are recorded as observed facts.

**Full regression (auto-strict only).** For a change that touches an auto-strict path or whose
contract says `tier: auto-strict`, `scope-check.js` outputs `strict=true` (fail-closed: true when the
policy lists no auto-strict paths or the contract can't be read). The `checks` job then runs
`Full regression (auto-strict) - held-out comparison, 10000 phrases` with the trusted fresh seed, on
top of the whole-crate golden suite (every ported case, every configuration). The controller reads
that step's conclusion from the jobs API (runner metadata, never log text, and only when the change
leaves `.github/` alone), records it on `check_result` as `full_regression`, and requires `success`
before any review or merge. Anything else → `needs_human/full_regression_missing`.

**Reviewer agent (auto-strict only).** Once an auto-strict PR meets every condition above, the
controller dispatches `review.lock.yml` (gh-aw, `gpt-6.1-sol`: a different model family from the
implementer) for that PR head, and records `review_dispatched` with the head **before** dispatching.
The reviewer reads the contract, the upstream source and the change (laid out as files by trusted
steps; nothing from the PR runs), with read-only tools, native file editing off (`edit: false`) and no network. Its only output is one
`factory-review` check run, posted by the **reviewer App**. A verdict counts only if:
- the check run's App id is the reviewer App's, **5444751** (`REVIEWER_APP_ID`, pinned in code so no variable can redirect it), and its name is `factory-review`
- it's on the PR's current head, and its summary's first line is `Reviewed-Head: <that head>`
- it started after the dispatch for that head, and at most 60 minutes after it (an older review never counts for a new head)
- that dispatch was for the **current contract** (`review_dispatched` records `contract_sha`). A review
  of this head against another contract version → `needs_human/review_contract_changed`

`success` → the merge stage goes on (`enqueue_merge`). Anything else → `needs_human/review_objected`.
No verdict 60 minutes after the dispatch → `needs_human/review_timeout`. A failed dispatch isn't
retried (the record already exists), so it ends in the timeout: fail closed, and never two paid
reviews for one head.

Queue history: GitHub's removal events don't say which head was queued, so each live `auto_merge`
record (which stores its `head_sha`) claims the first non-`merged` removal after it. If the controller's
enqueue of the **current head** was removed, or someone else's queue entry was removed and the controller
never queued this head, the PR goes to `needs_human/merge_queue_rejected` and is never re-queued
automatically. A removal claimed by an older head's enqueue doesn't block a new head.

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
6. strict lane (`wip.core_area`, factory-wide): tasks with a core path **or** an effective tier of
   `auto-strict` (by paths or contract). At most `core_area` (1) of them in flight at once, whatever their areas
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
- **A repair needs green gates:** a `ci` failure is only acted on when the newest `gates` run on the
  same head completed with `success`; otherwise the task waits (`gates_pending`).
- **Too many open PRs:** heads beyond `MAX_HEAD_LOOKUPS` are not looked up, so their PRs wait
  (`check_runs_incomplete`) instead of acting on a possibly stale run.
- **`merge_group` runs** are recorded as `check_result` but never trigger repairs.

**One terminal decision per task per run**

A task whose issue **or** PR already has `needs-human` is with a human: it gets no repair and no contract
decision.

Task timeouts are evaluated first. A task escalated to `needs_human` in this run, for any reason, gets
no other decision in that run: no repair, no contract decision and no second escalation.

**In flight**

A task is in flight if it has an open PR with `Factory-Task:`, its issue has `factory:picked`, or a
non-dry-run `picked`/`dispatched` event exists.

**History**

History comes only from **non-dry-run** audit events: picked time, repairs, signatures and spend. So
v1's own dry-run decisions never count as real work.

**Spend is measured every run, before planning (`spend.ts`), and fails closed.** For each
`implement.lock.yml` run created today (UTC):

| Run | Counted as |
|---|---|
| queued / in progress | **reserved** at the per-run caps: implement runs `budgets.per_run.implement + per_run.threat_detection` (500 + 400); reviewer runs (`review.lock.yml`) `per_run.reviewer_agent + per_run.threat_detection` (200 + 400). If either workflow's runs can't be listed, spend is unknown |
| queued / in progress, but every job completed including the final `conclusion` job | **measured** like a completed run (GitHub's run-level status can lag long after the jobs end; seen on run 39832616767). If the jobs can't be listed, it stays reserved |
| completed, no job's `Execute …` step ran (e.g. dispatch validation failed) | **0** (`no_inference`): no model calls were made |
| completed, with model calls | **measured** from gh-aw's `usage` artifact: the agent from `agent_usage.json` → `ai_credits`; every other job whose `Execute …` step ran (detection, and evals or others if gh-aw adds them) from the sum of `ai_credits_this_response` in `<job>/token_usage.jsonl` |

If **any** completed run's spend can't be read, today's spend is **unknown** (`null` →
`wait/budget_unknown`): no or expired `usage` artifact, more than one, a download/API error, a missing or
malformed accounting file, a zip that fails its size/CRC checks (stored/deflate only, no ZIP64 or
encryption, ≤ 20 MB), a re-run (attempt > 1), or an unexpected job name. No runs today means a measured
**0**. The artifact zip is read with Node's zlib; nothing is executed.

When spend is known, the controller records a `spend_snapshot` (`day`, `aic_today`, `runs[{run_id,
status, aic}]`, `runs_total`) with **`dry_run: false` in both modes** (it's a measurement, not a
decision), deduped on the total and its sources, so it's only re-recorded when something changed. The
planner uses the fresh measurement directly; fixture mode uses the snapshot's value.

## Modes: dry-run and live

**Dry-run** (default, and whenever `FACTORY_ENABLED` isn't exactly `"true"`, including unset, `TRUE`, `1`):
- The executor has **no GitHub client**. It only formats `would …` log lines.
- Every audit event is written with `dry_run: true`.
- The real client (`github.ts`) calls `assertAllowedRequest(…, 'dry-run')` before every request. It
  refuses everything except: GETs; read-only GraphQL `query`; `POST git/blobs|trees|commits`;
  `PATCH git/refs/heads/audit` with `force: false`; `POST git/refs` for `refs/heads/audit`.
- The workflow requests the App token with `contents: write` plus **read** scopes only.
- `--fixture` mode is always dry-run.

**Live** (`FACTORY_ENABLED=true`): exactly these effects become real.

| Decision effect | What the controller does (in this order) |
|---|---|
| `dispatch_workflow:implement` | add `factory:picked` to the task issue, then dispatch `implement.lock.yml` on `main` with `{task, issue, attempt, contract_sha}` (full SHA) |
| `label:needs-human` | add `needs-human` to the PR and/or issue, then one templated comment on the PR (or the issue) |
| `label:blocked` | add `blocked`, then one templated comment |
| `label:stale-contract` | add `stale-contract`, then one templated comment |
| `dispatch_workflow:repair` | there is no repair workflow yet, so it becomes `needs_human`/`repair_unavailable`: label + comment |
| `enqueue_merge` | GraphQL `enqueuePullRequest` for the PR with `expectedHeadOid` = the planned head (exact mutation), then record `auto_merge` with its head. If GitHub refuses (GraphQL error or HTTP 4xx): re-read the PR head. If it moved, the plan is stale, nothing is recorded, and the next poll re-plans. Otherwise `needs_human`/`enqueue_failed` (label + comment). Once that failure is recorded, that PR and head are never sent to GitHub again, even if the hand-off was interrupted. HTTP 5xx fails the run, and the next poll retries. |
| `dispatch_workflow:review` | record `review_dispatched` (with the head) first, then dispatch `review.lock.yml` on `main` with `{task, pr, head_sha, contract_sha}` (full SHAs). A failed dispatch is never retried; the review times out to a person |
| `close_task` | record `task_done` (once), then remove `factory:ready` and `factory:picked` from the issue (a 404 for a label that's already gone is fine), then close it with `state_reason: completed`. The effect re-runs whenever it's planned (the issue is still open), so an interrupted close finishes on the next poll; the event isn't recorded twice. This also backfills tasks merged before this stage existed (#45). |
| `alert:owner`, `pause_dispatch`, `none` | no GitHub effect; recorded in the audit log only |

- **Once per decision.** An effect runs only if its **live** audit event is new. Live decision events
  add `mode:live` to their dedupe identity, so a decision recorded in dry-run (switch off) doesn't
  count as done once the switch is on. Every event is validated before any effect, and recorded
  with `dry_run: false`.
- **Hand-offs finish even if a step fails.** For a label effect the decision is recorded first,
  then the label(s), then one comment carrying a hidden `<!-- factory-decision: <key> -->` marker,
  then a `handoff_done` event. Each live run first finishes any recorded hand-off without
  `handoff_done` (at most 20 per run): labels are re-added (idempotent), and the comment is posted
  only if none with its marker exists. The planner skips human-held tasks, so it wouldn't retry them.
- **No double dispatch.** `factory:picked` is added before the dispatch. If the dispatch or the
  record fails, the run fails (fail closed), and the next run sees a picked issue with no pick time:
  `needs_human`/`pick_time_unknown`, never a second dispatch.
- **Comments** come from a fixed template: `**Factory controller** · <type> (<reason>)`, one fixed
  sentence per reason code, the label, and the run link. No text from issues, PRs or agents.
- **The client's allowlist** (`assertAllowedRequest(…, 'live')`) independently allows only:
  `POST actions/workflows/implement.lock.yml/dispatches` with `ref: main` and exactly the four
  validated string inputs (no `aw_context`); the same for `review.lock.yml` with exactly `{task, pr, head_sha, contract_sha}`; `POST issues/<n>/labels` with labels from
  `factory:picked`, `needs-human`, `blocked`, `stale-contract`; `POST issues/<n>/comments` with a body
  starting with the template marker (≤ 2,000 chars); and the exact `enqueuePullRequest` GraphQL
  mutation with one `PR_…` node id and a 40-hex `expectedHeadOid` (no other variables, no queue jumping);
  `PATCH issues/<n>` with exactly `{state: closed, state_reason: completed}`; `DELETE
  issues/<n>/labels/<factory:ready|factory:picked>` (no body); and the exact
  `updateProjectV2ItemFieldValue` mutation with `PVT_`/`PVTI_`/`PVTSSF_` ids and one option id. It
  still refuses direct merges, dequeues, other closes or issue edits, removing any other label, adding
  `factory:ready`, reviews, other workflows, other refs and every other GraphQL mutation.
- The workflow requests `actions`, `issues`, `pull-requests` and `organization-projects` **write** only when
  `vars.FACTORY_ENABLED` is exactly `true`, checked case-sensitively in a shell step (Actions
  expressions compare strings case-insensitively). The controller applies the same rule.
- **Dispatch also needs a spend record.** The planner waits (`budget_unknown`) unless a non-dry-run
  `spend_snapshot` for today exists (see History), so live mode alone doesn't dispatch anything.

Both modes: the workflow uses `pull_request_target` and always checks out `main`, so PR code never runs
with the App token; the token is minted after `npm ci` and `npm test`. `test/main.test.ts` runs the
whole pipeline against a recording fake in both modes, and checks every call against the allowlist.

## Project status (`project.ts`)

Each run (not in `--fixture` mode) reads org Project #1 after the effects, and sets "Factory status"
on every item that is an issue of this repo with a task marker, when its current value differs:

| status | when |
|---|---|
| `Live` | the task has a merged PR (whatever the issue state) |
| `Needs you` | the issue or the task's open PR has `needs-human`, `blocked` or `stale-contract` |
| `Checks` | the task has an open PR |
| `Building` | the issue has `factory:picked` |
| `Ready` | the issue has `factory:ready` |
| `Proposed` | none of the above |

Issues closed without their task merged, items without a task marker, and other repos' items are
left alone. It never adds or removes items, and `Repairing` isn't used (there's no repair workflow).
Live only; dry-run logs `[dry-run] would set Factory status …`. It's a projection for people, not a
record, so it writes no audit events, and it's **best-effort**: an unreadable Project, a missing
option or a refused update stops the sync, shows in the run summary (`Project status: stopped …`),
and is redone next poll, but never fails the run.

## Files

| file | purpose |
|---|---|
| `types.ts` | shared types |
| `canonical.ts` | canonical JSON |
| `audit.ts` | event construction, dedupe keys, hash chain, `verify`, the `audit` branch writer |
| `tasks.ts` | marker/trailer/contract parsing, globs, tiers, area locks |
| `planner.ts` | pure planner |
| `observe.ts` | snapshot → observed fact events |
| `history.ts` | task history and spend from non-dry-run audit events |
| `spend.ts` | today's implement and reviewer spend from gh-aw usage artifacts (reserved / measured / unknown) |
| `heartbeat.ts` | heartbeat due check and hour-bucket dedupe |
| `executor.ts` | the mode switch (`isLive`), dry-run logger, live effects, decision → event |
| `project.ts` | Project #1 "Factory status" sync (desired status, read, exact update) |
| `github.ts` | fetch client with write guard, pagination, GraphQL, snapshot reader, CI log parsing |
| `policies.ts` | pinned policy loader and validation |
| `fake.ts` | in-memory GitHub fake (tests and `--fixture`) |
| `main.ts` | entrypoint |
