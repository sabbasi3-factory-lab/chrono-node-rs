#!/usr/bin/env bash
# Deliberate drill failures in `ci` (drills/README.md). Runs on pull_request only, and does nothing
# unless the PR changes a drill scope file. PR code can't change this script: drills/ is outside
# every drill contract's scope (the trusted gates check rejects it).
#   BASE_SHA, HEAD_SHA: the PR's base and head commits.
#
# Modes (D4-D8, drills/README.md). Each can only make a step fail, never pass:
#   ci-drill.sh                  the `Drill (deliberate)` step (D1, D1b, D2)
#   ci-drill.sh full-regression  inside the full-regression step (D5): fails when the PR changes
#                                the D5 drill file
#   ci-drill.sh post-merge       on push to main (D7): fails when the pushed commit adds the D7
#                                drill file (the revert, which deletes it, passes)
set -euo pipefail
D5=src/locales/en/parsers/factory_drill_full_regression.rs
D7=src/locales/en/parsers/factory_drill_post_merge.rs
case "${1:-}" in
    post-merge)
        [[ "${HEAD_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || { echo "::error::drill post-merge: HEAD_SHA must be a full SHA"; exit 1; }
        if git rev-parse -q --verify "${HEAD_SHA}^" >/dev/null && git diff --name-only --no-renames --diff-filter=A "${HEAD_SHA}^" "$HEAD_SHA" | grep -qxF "$D7"; then
            echo "::error::Drill D7 (deliberate post-merge failure): this push adds ${D7}. The controller should open a revert PR (factory/revert-*)."
            exit 1
        fi
        echo "drill post-merge: ok"
        exit 0
        ;;
    full-regression)
        [[ "${BASE_SHA:-}" =~ ^[0-9a-f]{40}$ && "${HEAD_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || { echo "drill full-regression: not a pull request, nothing to check"; exit 0; }
        base=$(git merge-base "$BASE_SHA" "$HEAD_SHA")
        if git diff --name-only --no-renames "$base" "$HEAD_SHA" | grep -qxF "$D5"; then
            echo "::error::Drill D5 (deliberate full-regression failure): the PR changes ${D5}. No change inside the contract's scope can pass this."
            exit 1
        fi
        echo "drill full-regression: ok"
        exit 0
        ;;
    "") ;;
    *) echo "::error::drill: unknown mode $1"; exit 1 ;;
esac
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
