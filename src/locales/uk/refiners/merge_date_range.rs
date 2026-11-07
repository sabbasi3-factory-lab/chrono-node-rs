//! upstream `locales/uk/refiners/UKMergeDateRangeRefiner.ts`.
//!
//! Merges "from" and "to" results into a range: "з 06.09.1989 [до|по] 11.12.1996", "з п'ятниці і до середи".

use crate::common::abstract_refiners::Merging;
use crate::common::merge_date_range::{MergeDateRange, MergeDateRangePattern};
use crate::core::chrono::Refiner;
use crate::core::configuration::Flags;
use crate::core::regex::JsRegex;
use crate::js_regex;

pub const UPSTREAM: &str = "UKMergeDateRangeRefiner";

pub fn create(_flags: &Flags) -> Box<dyn Refiner> {
    Box::new(Merging::new(MergeDateRange(UkMergeDateRangeRefiner)))
}

struct UkMergeDateRangeRefiner;

impl MergeDateRangePattern for UkMergeDateRangeRefiner {
    fn pattern_between(&self) -> &JsRegex {
        js_regex!(r"^\s*(і до|і по|до|по|-)\s*$", "i")
    }
}
