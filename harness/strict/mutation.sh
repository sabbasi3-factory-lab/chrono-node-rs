#!/usr/bin/env bash
# Strict gate mutation_score_not_lower (tiers.yaml), run by ci's `checks` job on auto-strict changes.
#
# Mutants come from cargo-mutants `--in-diff`, so only the code the change touches is mutated:
#   head: the change's added and modified lines, on the PR tree;
#   base: the lines it replaced, on the base tree.
# Score = (caught + timeout) / (caught + missed + timeout); unviable mutants don't count.
# Pass if head >= base. A pure addition (base has no viable mutant) needs head >= FLOOR.
# Enforced on factory pull requests only; a person's PRs, the merge queue and main get a notice.
# Each cargo-mutants run is capped at CAP_SECONDS; hitting the cap fails closed.
#   BASE_REV, KIND, EVENT, CAP_SECONDS, FLOOR (0..1)
set -euo pipefail
fail() { echo "::error::mutation_score_not_lower: $*"; exit 1; }
[[ "${BASE_REV:-}" =~ ^[0-9a-f]{40}$ ]] || fail "no base revision"
[[ "${CAP_SECONDS:-}" =~ ^[1-9][0-9]*$ && "${FLOOR:-}" =~ ^(0(\.[0-9]+)?|1(\.0+)?)$ ]] || fail "bad CAP_SECONDS or FLOOR"
if [ "${KIND:-}" != "factory" ]; then echo "::notice::mutation_score_not_lower: not a factory PR, not enforced"; exit 0; fi
if [ "${EVENT:-}" != "pull_request" ]; then echo "mutation_score_not_lower: checked on the pull request (this run is ${EVENT:-?})"; exit 0; fi

files=()
while IFS= read -r f; do files+=("$f"); done < <(git diff --name-only --no-renames "$BASE_REV" HEAD -- 'src/*.rs' 'src/**/*.rs' | grep -v '^src/bin/' || true)
[ "${#files[@]}" -gt 0 ] || { echo "mutation_score_not_lower: no library source changed"; exit 0; }
printf 'mutating changed lines of: %s\n' "${files[@]}"
# Skipping mutants in the changed code would hide it from the gate.
if git diff --no-renames "$BASE_REV" HEAD -- "${files[@]}" | grep -nE '^\+.*mutants::skip'; then fail "the change adds a mutants::skip"; fi

work="${RUNNER_TEMP:-/tmp}/factory-mutation"
rm -rf "$work" && mkdir -p "$work"
git diff --no-renames "$BASE_REV" HEAD -- "${files[@]}" > "$work/head.diff"
git diff --no-renames HEAD "$BASE_REV" -- "${files[@]}" > "$work/base.diff"
git worktree add -q --detach "$work/base" "$BASE_REV"
trap 'git worktree remove --force "$work/base" >/dev/null 2>&1 || true' EXIT

# run <dir> <diff> <out>: cargo-mutants exit 0 (all caught), 2 (missed) and 3 (timeouts) are results.
run() {
    local rc=0
    timeout "$CAP_SECONDS" cargo mutants --dir "$1" --in-diff "$2" --no-shuffle --jobs 2 --output "$3" \
        -- --lib --test golden --test configurations > "$3.log" 2>&1 || rc=$?
    tail -3 "$3.log"
    case "$rc" in
        0 | 2 | 3) ;;
        124) fail "cargo mutants hit the ${CAP_SECONDS}s cap on $(basename "$3") (fail closed)" ;;
        *) cat "$3.log"; fail "cargo mutants failed on $(basename "$3") (exit $rc)" ;;
    esac
}
# counts <out>: "detected viable" (0 0 when there were no mutants).
counts() {
    local f="$1/mutants.out/outcomes.json"
    [ -f "$f" ] || { echo "0 0"; return; }
    jq -r '"\((.caught // 0) + (.timeout // 0)) \((.caught // 0) + (.missed // 0) + (.timeout // 0))"' "$f"
}
run "$PWD" "$work/head.diff" "$work/head"
run "$work/base" "$work/base.diff" "$work/base-out"
read -r hd hv < <(counts "$work/head")
read -r bd bv < <(counts "$work/base-out")
echo "head (changed lines): ${hd}/${hv} detected; base (replaced lines): ${bd}/${bv} detected"
[ -f "$work/head/mutants.out/missed.txt" ] && [ -s "$work/head/mutants.out/missed.txt" ] && { echo "missed in the change:"; sed 's/^/  /' "$work/head/mutants.out/missed.txt"; }
[ "$hv" -gt 0 ] || { echo "mutation_score_not_lower: no viable mutant in the change"; exit 0; }
if [ "$bv" -gt 0 ]; then
    # head/hv >= bd/bv, in integers.
    [ $((hd * bv)) -ge $((bd * hv)) ] || fail "score ${hd}/${hv} on the change is lower than main's ${bd}/${bv} on the lines it replaced"
else
    awk -v d="$hd" -v v="$hv" -v f="$FLOOR" 'BEGIN { exit !(d / v >= f) }' || fail "new code scores ${hd}/${hv}, below the floor ${FLOOR}"
fi
echo "mutation_score_not_lower: ok"
