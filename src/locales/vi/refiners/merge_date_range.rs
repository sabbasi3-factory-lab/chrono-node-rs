//! upstream `locales/vi/refiners/VIMergeDateRangeRefiner.ts`.

use crate::common::abstract_refiners::Merging;
use crate::common::merge_date_range::{MergeDateRange, MergeDateRangePattern};
use crate::core::chrono::Refiner;
use crate::core::configuration::Flags;
use crate::core::regex::JsRegex;
use crate::js_regex;

pub const UPSTREAM: &str = "VIMergeDateRangeRefiner";

pub fn create(_flags: &Flags) -> Box<dyn Refiner> {
    Box::new(Merging::new(MergeDateRange(ViMergeDateRangeRefiner)))
}

struct ViMergeDateRangeRefiner;

impl MergeDateRangePattern for ViMergeDateRangeRefiner {
    fn pattern_between(&self) -> &JsRegex {
        js_regex!(r"^\s*(?:–|-|đến|tới|và)\s*$")
    }
}
