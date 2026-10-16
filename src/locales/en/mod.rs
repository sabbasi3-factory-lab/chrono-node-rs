//! English (upstream `src/locales/en/`).
//!
//! `parsers/` and `refiners/` are auto-registered (see `build.rs`); don't add `mod` lines for them.

use std::sync::LazyLock;

use crate::core::chrono::Chrono;

pub mod configuration;
pub mod constants;

pub mod parsers {
    //! Auto-registered English parsers.
    include!(concat!(env!("OUT_DIR"), "/registry/en_parsers.rs"));
}

pub mod refiners {
    //! Auto-registered English refiners.
    include!(concat!(env!("OUT_DIR"), "/registry/en_refiners.rs"));
}

static CASUAL: LazyLock<Chrono> = LazyLock::new(|| configuration::create_casual_configuration(false).build());
static STRICT: LazyLock<Chrono> = LazyLock::new(|| configuration::create_configuration(true, false).build());
static GB_CASUAL: LazyLock<Chrono> = LazyLock::new(|| configuration::create_casual_configuration(true).build());
static GB_STRICT: LazyLock<Chrono> = LazyLock::new(|| configuration::create_configuration(true, true).build());

/// `chrono.en.casual`.
pub fn casual() -> &'static Chrono {
    &CASUAL
}

/// `chrono.en.strict`.
pub fn strict() -> &'static Chrono {
    &STRICT
}

/// `chrono.en.GB` (casual, day before month).
pub fn gb() -> &'static Chrono {
    &GB_CASUAL
}

/// Strict, day before month (`createConfiguration(true, true)`).
pub fn gb_strict() -> &'static Chrono {
    &GB_STRICT
}
