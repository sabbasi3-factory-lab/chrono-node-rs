#!/usr/bin/env bash
# Strict gate code_health_not_worse (tiers.yaml), run by ci's `checks` job on auto-strict changes.
#
# Counts clippy's complexity warnings that the default `-D warnings` run doesn't already deny
# (LINTS below), per changed library file, on the change and on its base. Fails if any changed
# file has more of any of these warnings than on the base (a new file starts from zero).
# Enforced on factory pull requests only; a person's PRs, the merge queue and main get a notice.
#   BASE_REV, KIND, EVENT
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
fail() { echo "::error::code_health_not_worse: $*"; exit 1; }
[[ "${BASE_REV:-}" =~ ^[0-9a-f]{40}$ ]] || fail "no base revision"
if [ "${KIND:-}" != "factory" ]; then echo "::notice::code_health_not_worse: not a factory PR, not enforced"; exit 0; fi
if [ "${EVENT:-}" != "pull_request" ]; then echo "code_health_not_worse: checked on the pull request (this run is ${EVENT:-?})"; exit 0; fi
LINTS=(clippy::cognitive_complexity clippy::too_many_lines clippy::fn_params_excessive_bools clippy::struct_excessive_bools)

files=()
while IFS= read -r f; do files+=("$f"); done < <(git diff --name-only --no-renames --diff-filter=AM "$BASE_REV" HEAD -- 'src/*.rs' 'src/**/*.rs' | grep -v '^src/bin/' || true)
[ "${#files[@]}" -gt 0 ] || { echo "code_health_not_worse: no library source changed"; exit 0; }

work="${RUNNER_TEMP:-/tmp}/factory-code-health"
rm -rf "$work" && mkdir -p "$work"
git worktree add -q --detach "$work/base" "$BASE_REV"
trap 'git worktree remove --force "$work/base" >/dev/null 2>&1 || true' EXIT

# counts <dir> <out>: "<file>\t<lint>" per warning, for the changed files only.
counts() {
    local flags=()
    for l in "${LINTS[@]}"; do flags+=(-W "$l"); done
    touch "$1/src/lib.rs" # never reuse a cached check that was run without these lints
    (cd "$1" && cargo clippy --locked --lib --message-format=json -- "${flags[@]}") > "$2.json" 2> "$2.log" || { cat "$2.log"; fail "cargo clippy failed in $1"; }
    # Repo-relative file names (code-health-count.jq), then only the changed files, matched exactly.
    jq -r --argjson lints "$(printf '%s\n' "${LINTS[@]}" | jq -R . | jq -s .)" --arg root "$(cd "$1" && pwd -P)/" \
        -f "$HERE/code-health-count.jq" "$2.json" \
      | awk -F '\t' 'NR == FNR { want[$0] = 1; next } ($1 in want)' <(printf '%s\n' "${files[@]}") - | sort > "$2.txt" || true
}
counts "$PWD" "$work/head"
counts "$work/base" "$work/base"
bad=0
for f in "${files[@]}"; do
    for l in "${LINTS[@]}"; do
        h=$(grep -cxF "$(printf '%s\t%s' "$f" "$l")" "$work/head.txt" || true)
        b=$(grep -cxF "$(printf '%s\t%s' "$f" "$l")" "$work/base.txt" || true)
        if [ "$h" -gt "$b" ]; then echo "::error file=${f}::code_health_not_worse: ${l} ${b} -> ${h} in ${f}"; bad=1; fi
        [ "$h$b" = "00" ] || echo "${f} ${l}: base ${b}, change ${h}"
    done
done
[ "$bad" -eq 0 ] || fail "the change adds complexity warnings (see above)"
echo "code_health_not_worse: ok (${#files[@]} file(s))"
