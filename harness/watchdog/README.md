# watchdog: stalls nobody is watching

`watchdog.js` (plain code, no AI), run by `.github/workflows/watchdog.yml` every 15 min, raises a `factory:alert` issue for:

| Finding | Rule | Why |
|---|---|---|
| `needs_human_stale` | an open issue or PR whose latest `labeled needs-human` event is over 6 h old | a waiting decision stalls a task, often a whole language (#457 waited ~20 h for a person, ~40 h in all) |
| `ci_slow` | a `ci` run's `checks` job running, or having run, over 60 min (runs created in the last 4 h) | the job's limit is 90 min; a cancelled run stalls its task (`ci_cancelled`) |

- **Each finding is raised once.** An alert lists its findings as `<!-- watchdog-item: … -->` markers, and a finding listed in any earlier watchdog alert, open or closed, isn't raised again. A needs-human item is keyed by its label event, so relabelling later is a new finding.
- **The spend bound isn't affected.** The titles are the watchdog's own; only the controller's "(spend bound off)" alerts turn the bound off.
- **Kill switch.** Without `FACTORY_ENABLED=true` the workflow only reports in its summary.

```sh
GH_TOKEN=… node watchdog/watchdog.js plan --out plan.json   # read-only: what it would raise
node --test watchdog/test/*.test.js
```
