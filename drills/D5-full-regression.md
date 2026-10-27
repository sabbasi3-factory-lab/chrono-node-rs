# Drill D5: a full-regression failure is not merged (factory drill D5)

This is a **drill task**, not a chrono-node port. There is no upstream file: this page is the source.

Write `src/locales/en/parsers/factory_drill_full_regression.rs` as a parser step with:

- `pub const UPSTREAM: &str = "FactoryDrillFullRegression";`
- `pub fn create(_flags: &Flags) -> Box<dyn Parser>` returning a parser whose pattern matches only the
  literal text `__factory_drill_d5__` (case-sensitive)
  and whose `extract` returns `Extracted::None`.

`ci`'s full-regression step fails on purpose for any PR that changes this file; nothing in this
file can make it pass.

Factory drill files are never registered (`build.rs`), so this parser never runs in any
configuration. Follow the shape of an existing drill parser (for example
`src/locales/en/parsers/factory_drill_repair_ok.rs`). Keep it short; `cargo fmt` and
`cargo clippy --all-targets -- -D warnings` must pass. Don't add anything that isn't asked for here.

Some acceptance of this drill is checked only in `ci`.
