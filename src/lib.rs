//! A Rust port of [chrono-node](https://github.com/wanasit/chrono): natural-language date parsing.
//!
//! ```
//! use chrono_node::{parse, JsDate, ReferenceInput};
//!
//! let reference = ReferenceInput::Date(JsDate::parse_iso("2012-08-10T09:00:00.000Z").unwrap());
//! let results = parse("Let's meet", &reference);
//! assert!(results.is_empty() || results[0].index > 0);
//! ```
//!
//! The port follows upstream closely, file by file. The system time zone is always UTC: a
//! reference without a time zone is read as UTC (see `PORTING.md`).

pub mod calculation;
pub mod common;
pub mod core;
pub mod locales;

pub use crate::core::chrono::{Chrono, Extracted, Parser, Refiner};
pub use crate::core::components::{Component, ParsingComponents};
pub use crate::core::context::{ParsingContext, ParsingOption};
pub use crate::core::js_date::JsDate;
pub use crate::core::reference::{ParsingReference, ReferenceInput, ReferenceWithTimezone};
pub use crate::core::result::ParsingResult;
pub use crate::core::timezone::TimezoneInput;

/// `chrono.casual` (English).
pub fn casual() -> &'static Chrono {
    locales::en::casual()
}

/// `chrono.strict` (English).
pub fn strict() -> &'static Chrono {
    locales::en::strict()
}

/// `chrono.parse(text, ref)` with the casual English configuration.
pub fn parse(text: &str, reference: &ReferenceInput) -> Vec<ParsingResult> {
    casual().parse(text, reference, &ParsingOption::default())
}

/// `chrono.parseDate(text, ref)` with the casual English configuration.
pub fn parse_date(text: &str, reference: &ReferenceInput) -> Option<JsDate> {
    casual().parse_date(text, reference, &ParsingOption::default())
}

/// A named configuration: `en.casual`, `en.strict`, `en.GB.casual` or `en.GB.strict`.
pub fn configuration(name: &str) -> Option<&'static Chrono> {
    match name {
        "en.casual" => Some(locales::en::casual()),
        "en.strict" => Some(locales::en::strict()),
        "en.GB.casual" => Some(locales::en::gb()),
        "en.GB.strict" => Some(locales::en::gb_strict()),
        _ => None,
    }
}
