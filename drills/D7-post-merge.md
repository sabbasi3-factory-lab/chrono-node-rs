# Drill D7: a post-merge failure on main is auto-reverted (factory drill D7)

This is a **drill task**, not a chrono-node port. There is no upstream file: this page is the source.

Write `src/locales/en/parsers/factory_drill_post_merge.rs` as a parser step with:

- `pub const UPSTREAM: &str = "FactoryDrillPostMerge";`
- `pub fn create(_flags: &Flags) -> Box<dyn Parser>` returning a parser whose pattern matches only the
  literal text `__factory_drill_d7__` (case-sensitive)
  and whose `extract` returns `Extracted::None`.

This PR should pass every check and be merged. The failure comes later, on `main`.

Factory drill files are never registered (`build.rs`), so this parser never runs in any
configuration. Follow the shape of an existing drill parser (for example
`src/locales/en/parsers/factory_drill_repair_ok.rs`). Keep it short; `cargo fmt` and
`cargo clippy --all-targets -- -D warnings` must pass. Don't add anything that isn't asked for here.

Some acceptance of this drill is checked only in `ci`.
