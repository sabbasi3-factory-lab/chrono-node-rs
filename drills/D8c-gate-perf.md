# Drill D8c: the perf gate blocks a slower change (factory drill D8c)

This is a **drill task**, not a chrono-node port. There is no upstream file: this page is the source.

Write `src/locales/en/parsers/factory_drill_gate_perf.rs` as a parser step with:

- `pub const UPSTREAM: &str = "FactoryDrillGatePerf";`
- `pub fn create(_flags: &Flags) -> Box<dyn Parser>` returning a parser whose pattern matches only the
  literal text `__factory_drill_d8c__` (case-sensitive)
  and whose `extract` returns `Extracted::None`.

The golden-phrases bench does twice the work when this file exists (a drill hook in
`benches/golden_phrases.rs`), so the `perf_regression_max_pct` strict gate must block the PR.

Factory drill files are never registered (`build.rs`), so this parser never runs in any
configuration. Follow the shape of an existing drill parser (for example
`src/locales/en/parsers/factory_drill_repair_ok.rs`). Keep it short; `cargo fmt` and
`cargo clippy --all-targets -- -D warnings` must pass. Don't add anything that isn't asked for here.

Some acceptance of this drill is checked only in `ci`.
