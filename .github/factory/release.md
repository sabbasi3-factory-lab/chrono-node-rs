# Releases

`.github/workflows/release.yml`, plain code, started by hand (Actions → release → Run workflow, on `main`). Nothing ships without the owner (DESIGN §10).

| Job | Runs | Does |
|---|---|---|
| `prepare` | always; read-only token, no secrets | picks the next version (`release/next-version.sh`), stamps it on the runner, `cargo package`, `cargo publish --dry-run`, semver check against the last release, run summary with the merged PRs |
| `draft` | not on a dry run; **environment `release`** (required reviewer: the owner) | creates a **draft** GitHub Release `v0.x.y` at the prepared commit, with notes generated from merged PRs (`.github/release.yml`) and the `.crate` attached |
| `publish` | only when the owner publishes the draft (the `release: published` event); **environment `crates-io`** (required reviewer: the owner) | checks the tag is a release this workflow prepared, rebuilds the package at the tag's commit, `cargo publish --locked` with a short-lived Trusted Publishing token |

Three owner gates: approving the `release` deployment, publishing the draft in the GitHub UI (which creates the tag), then approving the `crates-io` deployment.

`publish` fails closed (nothing is uploaded) unless all of these hold:

- the tag is `v0.x.y` and the run is for that tag;
- the release carries `chrono-node-rs-<version>.crate`, and `gh attestation verify` proves it was built by `release.yml` on `main` from exactly the tag's commit (GitHub-hosted runner);
- the tag's commit is on `main`;
- the package rebuilt at that commit (stamped by `release/stamp.sh`, as in `prepare`) has the same files, byte for byte, as the attested `.crate`.

It uses no cache, and its `id-token: write` permission exists only after the owner's approval.

## Versions

- **The tag is the source of truth.** On `main`, `Cargo.toml` stays at `0.0.0` with `publish = false`, so nothing can be published by accident and no release commit touches `Cargo.toml` (a dependency-steward path). `prepare` and `publish` stamp (`release/stamp.sh`) the version into `Cargo.toml` and our own `Cargo.lock` entry on the runner only, and fails if stamping changes anything else.
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

## What's published

`Cargo.toml` `include` is an allowlist: `src/` (Rust files and generated-locale `locale.json`), `build.rs`, `README.md` (the crates.io page; its usage example runs as a doc test), `PORTING.md`, `LICENSE` and `NOTICE` (chrono-node's MIT notice), plus `Cargo.toml` and `Cargo.lock`. Not shipped: `upstream/`, `harness/`, `contracts/`, `tests/` (the goldens), `benches/`, `scripts/`, `.github/`. Cargo warns that the tests and the bench are ignored; that's expected. MSRV is `rust-version = 1.85` (checked with `cargo +1.85 check`); docs.rs builds one target (`[package.metadata.docs.rs]`).

Check locally (stamp a scratch copy, never commit it):

```sh
cp Cargo.toml Cargo.toml.bak && VERSION=0.1.0 bash .github/factory/release/stamp.sh
cargo package --list --allow-dirty        # only the files above
cargo publish --dry-run --locked --allow-dirty
cargo doc --no-deps && cargo test --doc   # crate docs and the README example
mv Cargo.toml.bak Cargo.toml && git checkout Cargo.lock
```

## Owner runbook: publishing to crates.io

Only a person can do these steps. The repo holds no long-lived crates.io token: after the first release, every publish uses crates.io **Trusted Publishing** (GitHub OIDC, `rust-lang/crates-io-auth-action`), which issues a token valid for one run.

### Once: the crates.io account

1. Go to <https://crates.io>, click **Log in with GitHub**, and authorise the crates.io app with the account that owns the crate (`sabbasi3`).
2. Click your avatar → **Account Settings** → **Profile**: add an email address and click the link in the verification email. crates.io refuses to publish from an account without a verified email.

### Once: the `crates-io` environment

GitHub → the repo → **Settings** → **Environments** → **New environment**, name `crates-io`:

1. **Required reviewers**: add yourself (`sabbasi3`). Leave **Prevent self-review** unticked: you start the release and approve it.
2. **Deployment branches and tags** → **Selected branches and tags** → **Add deployment branch or tag rule** → type **Tag**, pattern `v0.*`.
3. No secrets yet (see the first publish).

### First publish (0.1.0): a one-time token

crates.io can only trust a publisher for a crate that already exists, so the first version needs a token. Recommended (the release still goes through the workflow and its checks):

1. crates.io → avatar → **Account Settings** → **API Tokens** → **New Token**:
   - Name: `chrono-node-rs first publish`
   - Expiration: the shortest offered (e.g. 7 days)
   - Scopes: **publish-new** only
   - Crates: `chrono-node-rs`
   - **Generate Token** and copy it (shown once).
2. GitHub → **Settings** → **Environments** → `crates-io` → **Environment secrets** → **Add environment secret**: name `CARGO_REGISTRY_TOKEN`, value the token. (Environment secret, not a repository secret: only the approved `publish` job can read it.)
3. Release as below. The `publish` run warns that it used the one-time token.
4. Straight afterwards: delete the `CARGO_REGISTRY_TOKEN` environment secret, and revoke the token on crates.io (**API Tokens** → **Revoke**).

Alternative (no token in GitHub at all): publish 0.1.0 by hand from your machine. Publish the draft release, then **reject** the `crates-io` deployment, and run, at the tag:

```sh
git fetch --tags && git checkout v0.1.0
VERSION=0.1.0 bash .github/factory/release/stamp.sh   # stamps Cargo.toml and Cargo.lock locally
cargo login            # paste a publish-new token for chrono-node-rs, then revoke it afterwards
cargo publish --locked --allow-dirty
git checkout -- Cargo.toml Cargo.lock && git checkout main
```

### Then: configure the trusted publisher (once, after 0.1.0 exists)

crates.io → <https://crates.io/crates/chrono-node-rs> → **Settings** → **Trusted Publishing** → **Add** → GitHub, with exactly:

| Field | Value |
|---|---|
| Repository owner | `sabbasi3-factory-lab` |
| Repository name | `chrono-node-rs` |
| Workflow filename | `release.yml` |
| Environment | `crates-io` |

From then on there is no token anywhere: the `publish` job exchanges its GitHub OIDC token for a crates.io token that expires with the run. If the crate settings offer requiring trusted publishing for new versions, turn it on.

### Each release

Before the first release: refresh the README **Status** section (it becomes the crates.io page for that version).

1. **Actions** → **release** → **Run workflow** on `main`, `dry_run` unticked (leave `level: auto`). The first release is `0.1.0`.
2. Check the `prepare` summary (version, merged PRs), then approve the `release` deployment (**Review deployments** → `release` → **Approve and deploy**).
3. **Releases** → the draft `v0.x.y` → edit the notes if you like → **Publish release**. This creates the tag and starts a new `release` run.
4. In that run, approve the `crates-io` deployment. `publish` checks the tag, rebuilds and publishes.
5. Check <https://crates.io/crates/chrono-node-rs> and, a few minutes later, <https://docs.rs/chrono-node-rs>.

If `publish` fails a check, nothing was uploaded: fix the cause, then delete the GitHub release and its tag and start again from step 1 (a published crates.io version can never be replaced, only yanked).

### Yanking a bad version

Yanking stops new projects from picking that version; existing `Cargo.lock` files keep working, and it can be undone. It doesn't delete anything.

- **crates.io UI**: <https://crates.io/crates/chrono-node-rs/versions> → the version's **⋯** menu → **Yank** (and **Unyank** to undo).
- **Command line**: create a token with the **yank** scope for `chrono-node-rs`, then `cargo yank --version 0.x.y chrono-node-rs` (undo: `cargo yank --version 0.x.y --undo chrono-node-rs`), and revoke the token.

Then release a fixed patch version as above. Mark the GitHub release as yanked in its notes; don't delete the tag.
