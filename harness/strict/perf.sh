#!/usr/bin/env bash
# Strict gate perf_regression_max_pct (tiers.yaml: 5), run by ci's `checks` job on auto-strict changes.
#
# Runs the criterion bench benches/golden_phrases.rs (every golden phrase, casual English) on the
# base and then on the change, with one shared CRITERION_HOME so criterion compares them. Fails
# only when criterion is confident the change is slower by more than MAX_PCT: the lower bound of
# the median's confidence interval is above MAX_PCT. A failure is re-measured once (base, then
# change) and must repeat, so one noisy runner sample doesn't fail the gate.
# Enforced on factory pull requests only; a person's PRs, the merge queue and main get a notice.
#   BASE_REV, KIND, EVENT, MAX_PCT
set -euo pipefail
fail() { echo "::error::perf_regression_max_pct: $*"; exit 1; }
[[ "${BASE_REV:-}" =~ ^[0-9a-f]{40}$ ]] || fail "no base revision"
[[ "${MAX_PCT:-}" =~ ^[0-9]+$ ]] || fail "bad MAX_PCT"
if [ "${KIND:-}" != "factory" ]; then echo "::notice::perf_regression_max_pct: not a factory PR, not enforced"; exit 0; fi
if [ "${EVENT:-}" != "pull_request" ]; then echo "perf_regression_max_pct: checked on the pull request (this run is ${EVENT:-?})"; exit 0; fi

work="${RUNNER_TEMP:-/tmp}/factory-perf"
rm -rf "$work" && mkdir -p "$work"
git worktree add -q --detach "$work/base" "$BASE_REV"
trap 'git worktree remove --force "$work/base" >/dev/null 2>&1 || true' EXIT
[ -f "$work/base/benches/golden_phrases.rs" ] || fail "the base has no benches/golden_phrases.rs (fail closed)"
# Drill D8c's bench hook (drills/README.md) only ever slows the change: a base that has the drill
# file would make every change look faster, so it's refused (fail closed). Removed with the drills.
[ ! -f "$work/base/src/locales/en/parsers/factory_drill_gate_perf.rs" ] || fail "the base has the D8c perf drill file (its bench hook would hide a regression)"
export CRITERION_HOME="$work/criterion"
ARGS=(--warm-up-time 2 --measurement-time 8 --sample-size 50 --noplot)

# bench <dir> <criterion args...>
bench() {
    local dir="$1"; shift
    (cd "$dir" && cargo bench --locked --bench golden_phrases -- "${ARGS[@]}" "$@") > "$work/bench.log" 2>&1 || { cat "$work/bench.log"; fail "cargo bench failed in ${dir}"; }
    grep -E "time:|change:|Performance|No change|regressed|improved" "$work/bench.log" || true
}
# lower bound of the median change, in percent (criterion's change/estimates.json, relative units).
lower_pct() {
    jq -r '.median.confidence_interval.lower_bound * 100' "$CRITERION_HOME/golden_phrases/change/estimates.json"
}
measure() {
    echo "base ${BASE_REV}:"; bench "$work/base" --save-baseline base
    echo "change:"; bench "$PWD" --baseline base
    lower_pct
}
lo=$(measure | tee /dev/stderr | tail -1)
echo "median change, lower bound of the 95% interval: ${lo}% (limit ${MAX_PCT}%)"
if awk -v l="$lo" -v m="$MAX_PCT" 'BEGIN { exit !(l > m) }'; then
    echo "slower than ${MAX_PCT}% on the first measurement; measuring again"
    lo=$(measure | tee /dev/stderr | tail -1)
    echo "again: lower bound ${lo}%"
    awk -v l="$lo" -v m="$MAX_PCT" 'BEGIN { exit !(l > m) }' && fail "the change is slower than its base by more than ${MAX_PCT}% (median, 95% interval lower bound ${lo}%), twice"
fi
echo "perf_regression_max_pct: ok"
