# Drill D2: an unrepairable failure escalates (factory drill D2)

This is a **drill task**, not a chrono-node port. There is no upstream file: this page is the source.

Write `src/locales/en/parsers/factory_drill_repair_escalate.rs` as a parser step with:

- `pub const UPSTREAM: &str = "FactoryDrillRepairEscalate";`
- `pub fn create(_flags: &Flags) -> Box<dyn Parser>` returning a parser whose pattern matches only the
  literal text `__factory_drill_d2__` (case-sensitive) and whose extract returns `Extracted::None`.

It isn't in any configuration, so it never runs in `chrono.casual` or `chrono.strict`. Follow the shape of an
existing parser (for example `src/locales/en/parsers/casual_time.rs`). Keep it short; `cargo fmt` and
`cargo clippy --all-targets -- -D warnings` must pass.

Some acceptance of this drill is checked only in `ci`.
