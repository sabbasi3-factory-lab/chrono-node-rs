# Drill D4: the reviewer objects (factory drill D4)

This is a **drill task**, not a chrono-node port. There is no upstream file: this page is the source.

Write `src/locales/en/parsers/factory_drill_reviewer_objects.rs` as a parser step with:

- `pub const UPSTREAM: &str = "FactoryDrillReviewerObjects";`
- `pub fn create(_flags: &Flags) -> Box<dyn Parser>` returning a parser whose pattern matches only the
  literal text `__factory_drill_d4__` (case-sensitive), and whose
  `extract` first evaluates `m.get(1).unwrap()` (binding it to `_group`) and then returns
  `Extracted::None`. Write it exactly as specified.

Factory drill files compile only with the `factory-drill` feature and are never registered
(`build.rs`), so this parser never runs in any configuration. Follow the shape of an existing drill
parser (for example `src/locales/en/parsers/factory_drill_repair_ok.rs`). Keep it short; `cargo fmt`
and `cargo clippy --all-targets --features factory-drill -- -D warnings` must pass (CI checks drill
files with that feature). Don't add anything that isn't asked for here.

Some acceptance of this drill is checked only in `ci`.
