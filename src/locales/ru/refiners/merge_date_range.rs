//! upstream `locales/ru/refiners/RUMergeDateRangeRefiner.ts`.
//!
//! Merges "from" and "to" results into a range: "c 06.09.1989 [до|по] 11.12.1996", "c пятницы и до среды".

use crate::common::abstract_refiners::Merging;
use crate::common::merge_date_range::{MergeDateRange, MergeDateRangePattern};
use crate::core::chrono::Refiner;
use crate::core::configuration::Flags;
use crate::core::regex::JsRegex;
use crate::js_regex;

pub const UPSTREAM: &str = "RUMergeDateRangeRefiner";

pub fn create(_flags: &Flags) -> Box<dyn Refiner> {
    Box::new(Merging::new(MergeDateRange(RuMergeDateRangeRefiner)))
}

struct RuMergeDateRangeRefiner;

impl MergeDateRangePattern for RuMergeDateRangeRefiner {
    fn pattern_between(&self) -> &JsRegex {
        js_regex!(r"^\s*(и до|и по|до|по|-)\s*$", "i")
    }
}
