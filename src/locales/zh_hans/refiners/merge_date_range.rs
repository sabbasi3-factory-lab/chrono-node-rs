//! upstream `locales/zh/hans/refiners/ZHHansMergeDateRangeRefiner.ts`.

use crate::common::abstract_refiners::Merging;
use crate::common::merge_date_range::{MergeDateRange, MergeDateRangePattern};
use crate::core::chrono::Refiner;
use crate::core::configuration::Flags;
use crate::core::regex::JsRegex;
use crate::js_regex;

pub const UPSTREAM: &str = "ZHHansMergeDateRangeRefiner";

pub fn create(_flags: &Flags) -> Box<dyn Refiner> {
    Box::new(Merging::new(MergeDateRange(ZhHansMergeDateRangeRefiner)))
}

struct ZhHansMergeDateRangeRefiner;

impl MergeDateRangePattern for ZhHansMergeDateRangeRefiner {
    fn pattern_between(&self) -> &JsRegex {
        js_regex!(r"^\s*(至|到|-|~|～|－|ー)\s*$", "i")
    }
}
