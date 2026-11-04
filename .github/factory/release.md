# Releases

`.github/workflows/release.yml`, plain code, started by hand (Actions → release → Run workflow, on `main`). Nothing ships without the owner (DESIGN §10).

| Job | Runs | Does |
|---|---|---|
| `prepare` | always; read-only token, no secrets | picks the next version (`release/next-version.sh`), stamps it on the runner, `cargo package`, `cargo publish --dry-run`, semver check against the last release, run summary with the merged PRs |
| `draft` | not on a dry run; **environment `release`** (required reviewer: the owner) | creates a **draft** GitHub Release `v0.x.y` at the prepared commit, with notes generated from merged PRs (`.github/release.yml`) and the `.crate` attached |
| `publish` | **never** (`if: false`) | placeholder for crates.io |

Two owner gates: approving the `release` deployment, then publishing the draft in the GitHub UI (which creates the tag).

## Versions

- **The tag is the source of truth.** On `main`, `Cargo.toml` stays at `0.0.0` with `publish = false`, so nothing can be published by accident and no release commit touches `Cargo.toml` (a dependency-steward path). `prepare` stamps the version into `Cargo.toml` and our own `Cargo.lock` entry on the runner only, and fails if stamping changes anything else.
- **0.x while languages are incomplete.** Major stays 0; 1.0 is an owner decision.
- `level: auto`:
  - no earlier `v0.*` tag → `0.1.0`
  - the public API broke since the last release (`cargo semver-checks check-release --release-type patch`) → minor
  - a language was added (a new `src/locales/<lang>/mod.rs`) → minor (DESIGN §10: a release after each completed language)
  - otherwise → patch
- A patch that breaks the public API is refused, whatever `level` says. A `cargo semver-checks` error (not a violation) fails the run.

## Dry run (the drill)

Run the workflow with `dry_run: true` (the default). `prepare` runs end to end and nothing else does. Locally, with fake earlier tags (`git tag v0.1.0 <commit>`, deleted afterwards), `next-version.sh` gives:

| Earlier tag at | Result |
|---|---|
| none | `0.1.0` (first release) |
| two commits back, no API change | `0.1.1` |
| before German and French existed | `0.2.0` (new languages: de, fr) |
| HEAD~1, with a `pub use` made private | `0.2.0` (API break); `level: patch` is refused |
| HEAD~1, with a change that doesn't compile | fails (`cargo semver-checks failed`) |

## Publishing to crates.io (owner decision, disabled)

The repo has no crates.io token and the job is disabled. To enable it, in one reviewed PR:

1. Create a `crates-io` environment with the owner as required reviewer, and add a crates.io API token (scoped to `publish-update` for this crate) as its `CARGO_REGISTRY_TOKEN` secret.
2. Replace the `publish` job's `if: false` and placeholder step with: check out the draft's commit, stamp the version as `prepare` does, `cargo publish --locked --allow-dirty`.
3. Decide whether `publish = false` stays on `main` (the stamp removes it on the runner).
