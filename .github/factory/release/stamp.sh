#!/usr/bin/env bash
# Stamp a release version on the runner only (release.yml `prepare` and `publish`). Plain code.
# Sets VERSION in Cargo.toml and our own Cargo.lock entry, and drops `publish = false` so cargo
# packages the crate as crates.io would. Fails if Cargo.toml isn't 0.0.0 or if stamping changes
# anything else in Cargo.lock. Nothing is committed.
set -euo pipefail
[[ "${VERSION:-}" =~ ^0\.[0-9]+\.[0-9]+$ ]] || { echo "::error::VERSION must be 0.x.y, got '${VERSION:-}'"; exit 1; }
# awk, not sed -i: the same on Linux runners and macOS (the owner's manual first publish).
awk -v v="$VERSION" '!done && $0 == "version = \"0.0.0\"" { print "version = \"" v "\""; done = 1; next } $0 == "publish = false" { next } { print }' Cargo.toml > Cargo.toml.stamped
mv Cargo.toml.stamped Cargo.toml
grep -qx "version = \"${VERSION}\"" Cargo.toml || { echo "::error::Cargo.toml version isn't 0.0.0 at this commit"; exit 1; }
! grep -qx 'publish = false' Cargo.toml || { echo "::error::publish = false is still set"; exit 1; }
cargo update -p chrono-node-rs --offline
[ "$(git diff --numstat Cargo.lock)" = "$(printf '1\t1\tCargo.lock')" ] || { echo "::error::stamping changed more than our Cargo.lock entry"; exit 1; }
