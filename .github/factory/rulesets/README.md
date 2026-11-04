# Rulesets kept as code

GitHub rulesets aren't files in the repo; these are the exact JSON bodies, so a change to one is
reviewed like code and applied with the commands below (owner or coordinator, admin token).

## `code-owner-review.json`: code-owner review for the human tier only

**Status: not applied, by owner decision (2026-11-04).** There is no general code-owner review:
the coordinator keeps approving human-tier PRs, and the tiers, gates, merge queue and policy-gated
auto-merges stay the controls. A small "break glass" set may get a required code-owner review
later: the kill switch, the audit verifier, the rulesets and the spend caps. This JSON stays as the
template for that. The planned build App is for attribution and least privilege, not approvals.
CODEOWNERS itself stays: it requests the owner's review and documents the human tier.

- `.github/CODEOWNERS` owns exactly the human tier of factory `policies/tiers.yaml`
  (`.github/`, `contracts/`, `harness/`, `tests/golden/`, `upstream/`, `NOTICE`), minus the three
  intake fix paths the `intake_fixes` policy merges without a person.
- A **separate** ruleset, so its bypass can't touch the main ruleset (`main: PR + merge queue`:
  required `checks` and `gates`, the merge queue, no bypass).
- **Agent and steward PRs are unaffected:** the agent's scope never includes an owned path (the
  scope gate rejects protected paths), and the steward changes only `Cargo.toml`/`Cargo.lock`.
  Controller revert PRs revert agent merges, so they touch only the agent's paths.
- **Bypass: repository admins, for pull requests only.** With one person owning the repo, the
  owner's own PRs can't get a second code owner's approval. If the break-glass set is applied, narrow
  `.github/CODEOWNERS` (or a second file) to those paths first.
- **Generated onboarding PRs** (`harness/onboard/`): the approved languages' generated paths
  (`contracts/<code>/`, `tests/golden/<module>/`, `harness/golden/coverage/<module>.json`) and the two
  golden indexes have no owner, so tiers.yaml `onboarding` decides, as for intake fixes. A new
  language in `onboarding.yaml` needs its three lines added here (a reviewed `.github/` change).

Apply, check, roll back:

```sh
R=sabbasi3-factory-lab/chrono-node-rs
gh api -X POST repos/$R/rulesets --input .github/factory/rulesets/code-owner-review.json --jq '.id'   # apply
gh api repos/$R/rules/branches/main --jq '[.[] | select(.type == "pull_request") | .parameters.require_code_owner_review]'
gh api -X PUT repos/$R/rulesets/<id> -f enforcement=disabled                                           # roll back
```

Verify once after applying: the next agent PR merges through the queue untouched, and the next
human-tier PR shows "Review required (code owner)" and merges through the admin bypass.

## Code scanning results (not applied yet)

`{"type": "code_scanning", "parameters": {"code_scanning_tools": [{"tool": "CodeQL", "security_alerts_threshold": "high_or_higher", "alerts_threshold": "errors"}]}}`
in the main ruleset would block a PR until CodeQL has analysed its head and found no new high or
critical alert in the diff (merge protection doesn't apply to merge-queue groups). It isn't applied
yet: the controller enqueues a PR as soon as `checks` and `gates` are green, and CodeQL's Rust
analysis (about 4 min) can still be running then. GitHub would refuse the enqueue, and the
controller hands a refused enqueue to a person (`merge_queue_rejected`). The controller must first
wait for code scanning on the head; then add the rule.
