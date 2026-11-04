//! Japanese (upstream `src/locales/ja/`).
//!
//! `parsers/` and `refiners/` are auto-registered (see `build.rs`); don't add `mod` lines for them.

use std::sync::LazyLock;

use crate::core::chrono::Chrono;

pub mod configuration;
pub mod constants;

pub mod parsers {
    //! Auto-registered Japanese parsers.
    include!(concat!(env!("OUT_DIR"), "/registry/ja_parsers.rs"));
}

pub mod refiners {
    //! Auto-registered Japanese refiners.
    include!(concat!(env!("OUT_DIR"), "/registry/ja_refiners.rs"));
}

static CASUAL: LazyLock<Chrono> = LazyLock::new(|| configuration::create_casual_configuration().build());
static STRICT: LazyLock<Chrono> = LazyLock::new(|| configuration::create_configuration(true).build());

/// `chrono.ja.casual`.
pub fn casual() -> &'static Chrono {
    &CASUAL
}

/// `chrono.ja.strict` (`createConfiguration(true)`).
pub fn strict() -> &'static Chrono {
    &STRICT
}
