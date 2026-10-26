#!/usr/bin/env bash
# Deliberate drill failures in `ci` (drills/README.md). Runs on pull_request only, and does nothing
# unless the PR changes a drill scope file. PR code can't change this script: drills/ is outside
# every drill contract's scope (the trusted gates check rejects it).
#   BASE_SHA, HEAD_SHA: the PR's base and head commits.
set -euo pipefail
[[ "${BASE_SHA:-}" =~ ^[0-9a-f]{40}$ && "${HEAD_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || { echo "::error::drill: BASE_SHA and HEAD_SHA must be full SHAs"; exit 1; }
base=$(git merge-base "$BASE_SHA" "$HEAD_SHA")
changed=$(git diff --name-only --no-renames "$base" "$HEAD_SHA")
D1=src/locales/en/parsers/factory_drill_repair_ok.rs
D2=src/locales/en/parsers/factory_drill_repair_escalate.rs
fail=0

if grep -qxF "$D1" <<<"$changed"; then
    # D1: the first attempt always fails. It passes once the file names the failed head, a commit
    # of this PR (not its head) that changed the file. Only a repair knows that SHA in advance.
    sha=$(git show "${HEAD_SHA}:${D1}" | sed -nE 's#^// drill: repaired after ([0-9a-f]{40})$#\1#p' | head -1)
    if [ -n "$sha" ] && [ "$sha" != "$HEAD_SHA" ] && git rev-list "${base}..${HEAD_SHA}" -- "$D1" | grep -qxF "$sha"; then
        echo "drill D1: repaired after ${sha}"
    else
        echo "::error::Drill D1 (deliberate first failure): add the line '// drill: repaired after <the failed head SHA, 40 hex>' to ${D1}. The failed head is the PR commit whose ci failed."
        fail=1
    fi
fi

if grep -qxF "$D2" <<<"$changed"; then
    # D2: a requirement outside the contract's scope, so no repair can meet it.
    if [ "$(git show "${HEAD_SHA}:drills/D2-unfixable.txt")" = "fixed" ]; then
        echo "drill D2: drills/D2-unfixable.txt says fixed"
    else
        echo "::error::Drill D2 (deliberate, can't be fixed in scope): drills/D2-unfixable.txt must contain exactly 'fixed'."
        fail=1
    fi
fi

[ "$fail" -eq 0 ] && echo "drill checks: ok"
exit "$fail"
