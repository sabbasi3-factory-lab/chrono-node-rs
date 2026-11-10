//! upstream `locales/nl/refiners/ITMergeDateRangeRefiner.ts`.
//!
//! Merges "from" and "to" results into a range: "2020-02-13 \[tot\] 2020-02-13", "Wednesday \[-\] Friday".

use crate::common::abstract_refiners::Merging;
use crate::common::merge_date_range::{MergeDateRange, MergeDateRangePattern};
use crate::core::chrono::Refiner;
use crate::core::configuration::Flags;
use crate::core::regex::JsRegex;
use crate::js_regex;

pub const UPSTREAM: &str = "ITMergeDateRangeRefiner";

pub fn create(_flags: &Flags) -> Box<dyn Refiner> {
    Box::new(Merging::new(MergeDateRange(ItMergeDateRangeRefiner)))
}

struct ItMergeDateRangeRefiner;

impl MergeDateRangePattern for ItMergeDateRangeRefiner {
    fn pattern_between(&self) -> &JsRegex {
        js_regex!(r"^\s*(a|al|-|–|fino\s*a|fino\s*al)\s*$", "i")
    }
}
