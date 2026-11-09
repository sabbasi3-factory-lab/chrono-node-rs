//! upstream `locales/ar/refiners/ARMergeDateTimeRefiner.ts`.
//!
//! Merges a date-only result and a time-only result: "غداً [في تمام] 6:00", "اليوم [,] 8:00".

use crate::common::abstract_refiners::Merging;
use crate::common::merge_date_time::{MergeDateTime, MergeDateTimePattern};
use crate::core::chrono::Refiner;
use crate::core::configuration::Flags;
use crate::core::regex::JsRegex;
use crate::js_regex;

pub const UPSTREAM: &str = "ARMergeDateTimeRefiner";

pub fn create(_flags: &Flags) -> Box<dyn Refiner> {
    Box::new(Merging::new(MergeDateTime(ArMergeDateTimeRefiner)))
}

struct ArMergeDateTimeRefiner;

impl MergeDateTimePattern for ArMergeDateTimeRefiner {
    fn pattern_between(&self) -> &JsRegex {
        js_regex!(r"^\s*(T|في\s*تمام|في|الساعة|ساعة|,|-)?\s*$", "iu")
    }
}
