//! upstream `locales/ru/refiners/RUMergeDateTimeRefiner.ts`.
//!
//! Merges a date-only result and a time-only result: "2020-02-13 [в] 6:00", "Завтра [,] 7:00".

use crate::common::abstract_refiners::Merging;
use crate::common::merge_date_time::{MergeDateTime, MergeDateTimePattern};
use crate::core::chrono::Refiner;
use crate::core::configuration::Flags;
use crate::core::regex::JsRegex;
use crate::js_regex;

pub const UPSTREAM: &str = "RUMergeDateTimeRefiner";

pub fn create(_flags: &Flags) -> Box<dyn Refiner> {
    Box::new(Merging::new(MergeDateTime(RuMergeDateTimeRefiner)))
}

struct RuMergeDateTimeRefiner;

impl MergeDateTimePattern for RuMergeDateTimeRefiner {
    fn pattern_between(&self) -> &JsRegex {
        js_regex!(r"^\s*(T|в|,|-)?\s*$")
    }
}
