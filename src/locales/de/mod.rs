//! German (upstream `src/locales/de/`).
//!
//! `parsers/` and `refiners/` are auto-registered (see `build.rs`); don't add `mod` lines for them.

use std::sync::LazyLock;

use crate::core::chrono::Chrono;

pub mod casual_time_components;
pub mod configuration;
pub mod constants;

pub mod parsers {
    //! Auto-registered German parsers.
    include!(concat!(env!("OUT_DIR"), "/registry/de_parsers.rs"));
}

pub mod refiners {
    //! Auto-registered German refiners.
    include!(concat!(env!("OUT_DIR"), "/registry/de_refiners.rs"));
}

static CASUAL: LazyLock<Chrono> = LazyLock::new(|| configuration::create_casual_configuration(true).build());
static STRICT: LazyLock<Chrono> = LazyLock::new(|| configuration::create_configuration(true, true).build());

/// `chrono.de.casual` (little endian).
pub fn casual() -> &'static Chrono {
    &CASUAL
}

/// `chrono.de.strict` (`createConfiguration(true)`, little endian).
pub fn strict() -> &'static Chrono {
    &STRICT
}
