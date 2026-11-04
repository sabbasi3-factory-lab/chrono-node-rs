//! Swedish (upstream `src/locales/sv/`).
//!
//! `parsers/` and `refiners/` are auto-registered (see `build.rs`); don't add `mod` lines for them.

use std::sync::LazyLock;

use crate::core::chrono::Chrono;

pub mod configuration;
pub mod constants;

pub mod parsers {
    //! Auto-registered Swedish parsers.
    include!(concat!(env!("OUT_DIR"), "/registry/sv_parsers.rs"));
}

pub mod refiners {
    //! Auto-registered Swedish refiners.
    include!(concat!(env!("OUT_DIR"), "/registry/sv_refiners.rs"));
}

static CASUAL: LazyLock<Chrono> = LazyLock::new(|| configuration::create_casual_configuration(true).build());
static STRICT: LazyLock<Chrono> = LazyLock::new(|| configuration::create_configuration(true, true).build());

/// `chrono.sv.casual` (little endian).
pub fn casual() -> &'static Chrono {
    &CASUAL
}

/// `chrono.sv.strict` (`createConfiguration(true)`, little endian).
pub fn strict() -> &'static Chrono {
    &STRICT
}
