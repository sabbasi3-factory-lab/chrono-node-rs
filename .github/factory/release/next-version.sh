#!/usr/bin/env bash
# The next 0.x release version (release.yml `prepare`). Plain code. Writes version, previous, why and
# sha to $GITHUB_OUTPUT (or prints them). LEVEL: auto | patch | minor.
#   - no earlier v0.* tag      → 0.1.0
#   - public API broke (cargo semver-checks against the last release, as a patch) → minor
#   - a language was added (a new src/locales/<lang>/mod.rs)                     → minor
#   - otherwise                → patch
# A patch that breaks the public API is refused, whatever LEVEL says. Major stays 0.
set -euo pipefail
shopt -s inherit_errexit 2>/dev/null || true
LEVEL="${LEVEL:-auto}"
[[ "$LEVEL" =~ ^(auto|patch|minor)$ ]] || { echo "::error::LEVEL must be auto, patch or minor"; exit 1; }
sha=$(git rev-parse HEAD)
prev=$(git tag -l 'v0.*' --sort=-v:refname | grep -E '^v0\.[0-9]+\.[0-9]+$' | head -1 || true)
out() { if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "$1=$2" >> "$GITHUB_OUTPUT"; fi; echo "$1=$2"; }

if [ -z "$prev" ]; then
  version=0.1.0
  why="first release"
else
  [ "$(git rev-parse "${prev}^{commit}")" != "$sha" ] || { echo "::error::nothing to release: main is ${prev}"; exit 1; }
  IFS=. read -r _ minor patch <<<"${prev#v}"
  # Exit 1 means a violation only with cargo-semver-checks' "Summary semver requires …" line;
  # anything else (a build or tool error) fails closed.
  breaking=no
  if ! cargo semver-checks check-release --baseline-rev "$prev" --release-type patch 2>&1 | tee "${RUNNER_TEMP:-/tmp}/semver.log"; then
    grep -q "Summary semver requires new" "${RUNNER_TEMP:-/tmp}/semver.log" || { echo "::error::cargo semver-checks failed"; exit 1; }
    breaking=yes
  fi
  new_lang=$(git diff --name-only --diff-filter=A "$prev" "$sha" -- 'src/locales/*/mod.rs' | sed -E 's#src/locales/([^/]+)/mod.rs#\1#' | paste -sd, - || true)
  level="$LEVEL"
  if [ "$level" = auto ]; then
    if [ "$breaking" = yes ] || [ -n "$new_lang" ]; then level=minor; else level=patch; fi
  fi
  [ "$level" = minor ] || [ "$breaking" = no ] || { echo "::error::the public API broke since ${prev}: a patch release isn't allowed"; exit 1; }
  if [ "$level" = minor ]; then version="0.$((minor + 1)).0"; else version="0.${minor}.$((patch + 1))"; fi
  why="${level} (${LEVEL}; API break: ${breaking}; new languages: ${new_lang:-none})"
fi
out version "$version"
out previous "$prev"
out why "$why"
out sha "$sha"
