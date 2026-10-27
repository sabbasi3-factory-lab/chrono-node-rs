# Drill D8d: the code-health gate blocks new complexity warnings (factory drill D8d)

This is a **drill task**, not a chrono-node port. There is no upstream file: this page is the source.

Write `src/locales/en/parsers/factory_drill_gate_code_health.rs` as a parser step with:

- `pub const UPSTREAM: &str = "FactoryDrillGateCodeHealth";`
- `pub fn create(_flags: &Flags) -> Box<dyn Parser>` returning a parser whose pattern matches only the
  literal text `__factory_drill_d8d__` (case-sensitive)
  and whose `extract` returns `Extracted::None`.
- `pub struct FactoryDrillFlags { pub a: bool, pub b: bool, pub c: bool, pub d: bool }` (four `bool`
  fields, deriving `Debug, Default`).

Four `bool` fields trip `clippy::struct_excessive_bools`, which the `code_health_not_worse` strict
gate counts (it isn't on by default, so `cargo clippy -D warnings` still passes).

Factory drill files compile only with the `factory-drill` feature and are never registered
(`build.rs`), so this parser never runs in any configuration. Follow the shape of an existing drill
parser (for example `src/locales/en/parsers/factory_drill_repair_ok.rs`). Keep it short; `cargo fmt`
and `cargo clippy --all-targets --features factory-drill -- -D warnings` must pass (CI checks drill
files with that feature). Don't add anything that isn't asked for here.

Some acceptance of this drill is checked only in `ci`.
