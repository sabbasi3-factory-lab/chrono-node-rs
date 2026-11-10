//! upstream `locales/de/refiners/DEMergeDateRangeRefiner.ts`.
//!
//! Merges "from" and "to" results into a range: "13.2. \[bis\] 15.2.", "Mittwoch \[bis\] Freitag".

use crate::common::abstract_refiners::Merging;
use crate::common::merge_date_range::{MergeDateRange, MergeDateRangePattern};
use crate::core::chrono::Refiner;
use crate::core::configuration::Flags;
use crate::core::regex::JsRegex;
use crate::js_regex;

pub const UPSTREAM: &str = "DEMergeDateRangeRefiner";

pub fn create(_flags: &Flags) -> Box<dyn Refiner> {
    Box::new(Merging::new(MergeDateRange(DeMergeDateRangeRefiner)))
}

struct DeMergeDateRangeRefiner;

impl MergeDateRangePattern for DeMergeDateRangeRefiner {
    fn pattern_between(&self) -> &JsRegex {
        js_regex!(r"^\s*(bis(?:\s*(?:am|zum))?|-)\s*$", "i")
    }
}
