//! upstream `locales/id/refiners/IDMergeDateRangeRefiner.ts`.
//!
//! Merges "from" and "to" results into a range: "Senin - Jumat", "13 Februari sampai 15 Februari".

use crate::common::abstract_refiners::Merging;
use crate::common::merge_date_range::{MergeDateRange, MergeDateRangePattern};
use crate::core::chrono::Refiner;
use crate::core::configuration::Flags;
use crate::core::regex::JsRegex;
use crate::js_regex;

pub const UPSTREAM: &str = "IDMergeDateRangeRefiner";

pub fn create(_flags: &Flags) -> Box<dyn Refiner> {
    Box::new(Merging::new(MergeDateRange(IdMergeDateRangeRefiner)))
}

struct IdMergeDateRangeRefiner;

impl MergeDateRangePattern for IdMergeDateRangeRefiner {
    fn pattern_between(&self) -> &JsRegex {
        js_regex!(
            r"^\s*(?:-|–|s\.d\.?|s\/d|sampai(?:\s+dengan)?|hingga)\s*$",
            "i"
        )
    }
}
