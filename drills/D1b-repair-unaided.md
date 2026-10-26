# Drill D1b: a repair push succeeds with no manual help (factory drill D1b)

This is a **drill task**, not a chrono-node port. There is no upstream file: this page is the source.

Write `src/locales/en/parsers/factory_drill_repair_unaided.rs` as a parser step with:

- `pub const UPSTREAM: &str = "FactoryDrillRepairUnaided";`
- `pub fn create(_flags: &Flags) -> Box<dyn Parser>` returning a parser whose pattern matches only the
  literal text `__factory_drill_d1b__` (case-sensitive) and whose extract returns `Extracted::None`.

It isn't in any configuration, so it never runs in `chrono.casual` or `chrono.strict`. Follow the shape of an
existing parser (for example `src/locales/en/parsers/casual_time.rs`). Keep it short; `cargo fmt` and
`cargo clippy --all-targets -- -D warnings` must pass.

Some acceptance of this drill is checked only in `ci`.
