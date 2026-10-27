#!/usr/bin/env bash
# Strict gate mutation_score_not_lower (tiers.yaml), run by ci's `checks` job on auto-strict changes.
#
# Mutants come from cargo-mutants `--in-diff`, so only the code the change touches is mutated:
#   head: the change's added and modified lines, on the PR tree;
#   base: the lines it replaced, on the base tree.
# Score = (caught + timeout) / (caught + missed + timeout); unviable mutants don't count.
# Pass if head >= base. A pure addition (base has no viable mutant) needs head >= the floor, policy
# tiers.yaml auto-strict.strict_gates_params.mutation_floor_new_files at the pinned factory version
# (.github/factory/factory-version); missing or invalid fails closed.
# Enforced on factory pull requests only; a person's PRs, the merge queue and main get a notice.
# Each cargo-mutants run is capped at CAP_SECONDS (then killed 60 s later); hitting the cap fails closed.
# Parser and refiner files are declared through build.rs-generated `include!`s, which cargo-mutants
# can't see, so each changed file it doesn't discover gets a `#[cfg(any())] #[path] mod` line in
# src/lib.rs for the run (restored afterwards; the real module still compiles the mutated file).
# A changed file that is still undiscovered fails closed.
#   BASE_REV, KIND, EVENT, CAP_SECONDS; TIERS_FILE (tests only: read tiers.yaml from this file)
set -euo pipefail
# shellcheck source=harness/strict/paths.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/paths.sh"
# shellcheck source=harness/strict/mutants.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/mutants.sh"
fail() { echo "::error::mutation_score_not_lower: $*"; exit 1; }
[[ "${BASE_REV:-}" =~ ^[0-9a-f]{40}$ ]] || fail "no base revision"
[[ "${CAP_SECONDS:-}" =~ ^[1-9][0-9]*$ ]] || fail "bad CAP_SECONDS"
if [ "${KIND:-}" != "factory" ]; then echo "::notice::mutation_score_not_lower: not a factory PR, not enforced"; exit 0; fi
if [ "${EVENT:-}" != "pull_request" ]; then echo "mutation_score_not_lower: checked on the pull request (this run is ${EVENT:-?})"; exit 0; fi

if [ -n "${TIERS_FILE:-}" ]; then
    tiers=$(cat "$TIERS_FILE")
else
    version=$(cat .github/factory/factory-version)
    [[ "$version" =~ ^[0-9a-f]{40}$ ]] || fail "bad .github/factory/factory-version"
    tiers=$(curl -fsSL --retry 3 "https://raw.githubusercontent.com/sabbasi3-factory-lab/factory/${version}/policies/tiers.yaml") || fail "cannot read tiers.yaml at factory ${version}"
fi
FLOOR=$(yq -r '.tiers."auto-strict".strict_gates_params.mutation_floor_new_files' <<<"$tiers") || fail "cannot parse tiers.yaml"
[[ "$FLOOR" =~ ^(0(\.[0-9]+)?|1(\.0+)?)$ ]] || fail "tiers.yaml has no valid auto-strict.strict_gates_params.mutation_floor_new_files (got '${FLOOR}'; fail closed)"
echo "floor for new code: ${FLOOR} (policy)"

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
cp src/lib.rs "$work/lib.rs.orig"
trap 'cp "$work/lib.rs.orig" src/lib.rs; git worktree remove --force "$work/base" >/dev/null 2>&1 || true' EXIT

# discover <dir> <files...>: make every given file that exists in <dir> visible to cargo-mutants.
discover() {
    local dir="$1"; shift
    local listed n=0 f
    listed=$(cd "$dir" && cargo mutants --list-files 2>/dev/null) || fail "cargo mutants --list-files failed in ${dir}"
    listed=$(rel_paths "$dir" <<<"$listed")
    for f in "$@"; do
        [ -f "$dir/$f" ] || continue
        grep -qxF "$f" <<<"$listed" && continue
        [[ "$f" =~ ^src/[A-Za-z0-9_/]+\.rs$ ]] || fail "unexpected path ${f}"
        printf '\n#[cfg(any())]\n#[path = "%s"]\nmod __factory_mutants_discover_%d;\n' "${f#src/}" "$n" >> "$dir/src/lib.rs"
        n=$((n + 1))
    done
    listed=$(cd "$dir" && cargo mutants --list-files 2>/dev/null) || fail "cargo mutants --list-files failed in ${dir}"
    listed=$(rel_paths "$dir" <<<"$listed")
    for f in "$@"; do
        [ -f "$dir/$f" ] || continue
        grep -qxF "$f" <<<"$listed" || fail "cargo-mutants can't see ${f} in ${dir} (fail closed)"
    done
}
discover "$PWD" "${files[@]}"
discover "$work/base" "${files[@]}"

# run <dir> <diff> <out>: cargo-mutants exit 0 (all caught), 2 (missed) and 3 (timeouts) are results.
run() {
    local rc=0
    timeout --kill-after=60 "$CAP_SECONDS" cargo mutants --dir "$1" --in-diff "$2" --no-shuffle --jobs 2 --output "$3" \
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
# On failure, list each surviving mutant as an annotation first (the repair agent's input).
fail_score() {
    [ -s "$work/head/mutants.out/missed.txt" ] && rel_paths "$PWD" < "$work/head/mutants.out/missed.txt" | annotate_missed 50
    fail "$@"
}
if [ "$bv" -gt 0 ]; then
    # head/hv >= bd/bv, in integers.
    [ $((hd * bv)) -ge $((bd * hv)) ] || fail_score "score ${hd}/${hv} on the change is lower than main's ${bd}/${bv} on the lines it replaced"
else
    awk -v d="$hd" -v v="$hv" -v f="$FLOOR" 'BEGIN { exit !(d / v >= f) }' || fail_score "new code scores ${hd}/${hv}, below the floor ${FLOOR}"
fi
echo "mutation_score_not_lower: ok"
