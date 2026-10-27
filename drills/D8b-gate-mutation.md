# Drill D8b: the mutation gate blocks untested new code (factory drill D8b)

This is a **drill task**, not a chrono-node port. There is no upstream file: this page is the source.

Write `src/locales/en/parsers/factory_drill_gate_mutation.rs` as a parser step with:

- `pub const UPSTREAM: &str = "FactoryDrillGateMutation";`
- `pub fn create(_flags: &Flags) -> Box<dyn Parser>` returning a parser whose pattern matches only the
  literal text `__factory_drill_d8b__` (case-sensitive)
  and whose `extract` returns `Extracted::None`.
- `pub fn drill_score(n: u32) -> u32`, returning `n * 2` when `n > 10` and `n + 1` otherwise.

Add **no tests** for `drill_score`: the `mutation_score_not_lower` strict gate must find its mutants
uncaught.

Factory drill files are never registered (`build.rs`), so this parser never runs in any
configuration. Follow the shape of an existing drill parser (for example
`src/locales/en/parsers/factory_drill_repair_ok.rs`). Keep it short; `cargo fmt` and
`cargo clippy --all-targets -- -D warnings` must pass. Don't add anything that isn't asked for here.

Some acceptance of this drill is checked only in `ci`.
