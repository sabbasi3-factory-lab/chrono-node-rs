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
D1B=src/locales/en/parsers/factory_drill_repair_unaided.rs
D2=src/locales/en/parsers/factory_drill_repair_escalate.rs
fail=0

# D1 and D1b: the first attempt always fails. It passes once the file names the failed head, a
# commit of this PR (not its head) that changed the file. Only a repair knows that SHA in advance.
for f in "$D1" "$D1B"; do
    grep -qxF "$f" <<<"$changed" || continue
    sha=$(git show "${HEAD_SHA}:${f}" | sed -nE 's#^// drill: repaired after ([0-9a-f]{40})$#\1#p' | head -1)
    if [ -n "$sha" ] && [ "$sha" != "$HEAD_SHA" ] && git rev-list "${base}..${HEAD_SHA}" -- "$f" | grep -qxF "$sha"; then
        echo "drill ${f}: repaired after ${sha}"
    else
        echo "::error::Drill (deliberate first failure): add the line '// drill: repaired after <the failed head SHA, 40 hex>' to ${f}. The failed head is the PR commit whose ci failed."
        fail=1
    fi
done

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
