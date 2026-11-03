//! upstream `locales/de/refiners/DEMergeDateTimeRefiner.ts`.
//!
//! Merges a date-only result and a time-only result: "13.2. um 18 Uhr".

use crate::common::abstract_refiners::Merging;
use crate::common::merge_date_time::{MergeDateTime, MergeDateTimePattern};
use crate::core::chrono::Refiner;
use crate::core::configuration::Flags;
use crate::core::regex::JsRegex;
use crate::js_regex;

pub const UPSTREAM: &str = "DEMergeDateTimeRefiner";

pub fn create(_flags: &Flags) -> Box<dyn Refiner> {
    Box::new(Merging::new(MergeDateTime(DeMergeDateTimeRefiner)))
}

struct DeMergeDateTimeRefiner;

impl MergeDateTimePattern for DeMergeDateTimeRefiner {
    fn pattern_between(&self) -> &JsRegex {
        js_regex!(r"^\s*(T|um|am|,|-)?\s*$")
    }
}
