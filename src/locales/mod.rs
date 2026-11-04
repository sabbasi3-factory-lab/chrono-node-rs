//! Locales. One module per language; each has `configuration.rs`, `parsers/` and `refiners/`.
//!
//! The hand-scaffolded languages are declared here. Generated languages
//! (`harness/onboard/onboard.js`, a `locale.json` in their directory) are declared by `build.rs`,
//! so onboarding one adds files and edits no shared line.

use crate::core::chrono::Chrono;
use crate::core::configuration::Configuration;

pub mod de;
pub mod en;
pub mod es;
pub mod fr;
pub mod ja;
pub mod pt;
pub mod sv;

/// A named configuration of a generated locale (`fi.casual`, ...).
pub struct NamedConfiguration {
    /// The upstream name, as in `tests/golden/configurations.json`.
    pub name: &'static str,
    /// The built `Chrono` (lazily, once).
    pub chrono: fn() -> &'static Chrono,
    /// The slot list, for the `configurations` test.
    pub configuration: fn() -> Configuration,
}

include!(concat!(env!("OUT_DIR"), "/registry/locales.rs"));

/// Every named configuration of the generated locales, in module order.
pub fn generated() -> impl Iterator<Item = &'static NamedConfiguration> {
    GENERATED.iter().flat_map(|named| named.iter())
}
