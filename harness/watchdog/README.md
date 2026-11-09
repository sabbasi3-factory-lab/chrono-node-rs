# watchdog: stalls nobody is watching

`watchdog.js` (plain code, no AI), run by `.github/workflows/watchdog.yml` after each controller run (at most once per 10 min) and on a 15-min cron (GitHub throttles this repo's cron to every few hours, so the cron is only a fallback), raises a `factory:alert` issue for:

| Finding | Rule | Why |
|---|---|---|
| `needs_human_stale` | an open issue or PR whose latest `labeled needs-human` event is over 6 h old | a waiting decision stalls a task, often a whole language (#457 waited ~20 h for a person, ~40 h in all) |
| `ci_slow` | a `ci` run's `checks` job running, or having run, over 60 min (runs created in the last 4 h) | the job's limit is 90 min; a cancelled run stalls its task (`ci_cancelled`) |
| `pr_green_stalled` | an open factory PR (head `factory/…`) whose newest `ci` run on its head passed over 2 h ago, not in the merge queue and not labelled needs-human (the alert shows its `gates` result, or "never ran") | nothing labels these: #477 was green but held by a stale `task_timeout`, and its gates never started (a GitHub `pull_request_target` brownout) |
| `task_no_progress` | an open `factory:picked` task issue (not needs-human) whose last controller progress event is over 6 h old. Progress means an audit-branch event naming the task, its issue, or one of its PRs (`Factory-Task:` trailer). Measurements (`run_spend`, `spend_snapshot`), `heartbeat`, `alert` and advisory `triage_dispatched` don't count. The floor is the latest reopen or pick label | a task can stall with no label, e.g. a decision deduplicated as "already done" |

- **Each finding is raised once.** An alert lists its findings as `<!-- watchdog-item: … -->` markers, and a finding listed in any earlier watchdog alert, open or closed, isn't raised again. A needs-human item is keyed by its label event, so relabelling later is a new finding. A green PR is keyed by its head (a new push is new), and a no-progress task by its last progress time (progress, then a new stall, is new).
- **The spend bound isn't affected.** The titles are the watchdog's own; only the controller's "(spend bound off)" alerts turn the bound off.
- **Kill switch.** Without `FACTORY_ENABLED=true` the workflow only reports in its summary.

```sh
GH_TOKEN=… node watchdog/watchdog.js plan --out plan.json   # read-only: what it would raise
node --test watchdog/test/*.test.js
```
