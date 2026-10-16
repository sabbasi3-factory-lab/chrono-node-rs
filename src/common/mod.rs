//! Steps shared by all locales (upstream `src/common/`).
//!
//! `parsers/` and `refiners/` are auto-registered (see `build.rs`); don't add `mod` lines for them.

pub mod casual_references;
pub mod configuration;
pub mod word_boundary;

pub mod parsers {
    //! Auto-registered common parsers.
    include!(concat!(env!("OUT_DIR"), "/registry/common_parsers.rs"));
}

pub mod refiners {
    //! Auto-registered common refiners.
    include!(concat!(env!("OUT_DIR"), "/registry/common_refiners.rs"));
}
