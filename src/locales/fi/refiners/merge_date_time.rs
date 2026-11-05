//! upstream `locales/fi/refiners/FIMergeDateTimeRefiner.ts`.
//!
//! Merges a date-only result and a time-only result.

use crate::common::abstract_refiners::Merging;
use crate::common::merge_date_time::{MergeDateTime, MergeDateTimePattern};
use crate::core::chrono::Refiner;
use crate::core::configuration::Flags;
use crate::core::regex::JsRegex;
use crate::js_regex;

pub const UPSTREAM: &str = "FIMergeDateTimeRefiner";

pub fn create(_flags: &Flags) -> Box<dyn Refiner> {
    Box::new(Merging::new(MergeDateTime(FiMergeDateTimeRefiner)))
}

struct FiMergeDateTimeRefiner;

impl MergeDateTimePattern for FiMergeDateTimeRefiner {
    fn pattern_between(&self) -> &JsRegex {
        js_regex!(r"^\s*(T|klo|kello|,|-)?\s*$")
    }
}
