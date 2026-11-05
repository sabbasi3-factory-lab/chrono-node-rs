//! upstream `locales/fi/refiners/FIMergeDateRangeRefiner.ts`.
//!
//! Merges "from" and "to" results into a range: "-" or "–" between.

use crate::common::abstract_refiners::Merging;
use crate::common::merge_date_range::{MergeDateRange, MergeDateRangePattern};
use crate::core::chrono::Refiner;
use crate::core::configuration::Flags;
use crate::core::regex::JsRegex;
use crate::js_regex;

pub const UPSTREAM: &str = "FIMergeDateRangeRefiner";

pub fn create(_flags: &Flags) -> Box<dyn Refiner> {
    Box::new(Merging::new(MergeDateRange(FiMergeDateRangeRefiner)))
}

struct FiMergeDateRangeRefiner;

impl MergeDateRangePattern for FiMergeDateRangeRefiner {
    fn pattern_between(&self) -> &JsRegex {
        js_regex!(r"^\s*(-|–)\s*$", "i")
    }
}
