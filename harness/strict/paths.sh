# Shared by the strict-gate scripts (sourced). Tools can report files under an absolute path: steps
# auto-registered by build.rs are included with an absolute `#[path]`, so clippy (and possibly other
# tools) name them by their canonical absolute path. Every comparison with `git diff --name-only`
# (repo-relative) must go through this first.
#
# rel_paths <checkout dir>: stdin lines → repo-relative where they start with the checkout's
# canonical root; other lines unchanged.
rel_paths() {
    local root
    root="$(cd "$1" && pwd -P)/"
    awk -v r="$root" 'index($0, r) == 1 { $0 = substr($0, length(r) + 1) } { print }'
}
