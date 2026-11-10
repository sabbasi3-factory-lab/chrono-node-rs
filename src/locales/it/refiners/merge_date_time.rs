//! upstream `locales/it/refiners/ITMergeDateTimeRefiner.ts`.
//!
//! Merges a date-only result and a time-only result: "2020-02-13 [alle] 18", "Domani [dopo le] 7".

use crate::common::abstract_refiners::Merging;
use crate::common::merge_date_time::{MergeDateTime, MergeDateTimePattern};
use crate::core::chrono::Refiner;
use crate::core::configuration::Flags;
use crate::core::regex::JsRegex;
use crate::js_regex;

pub const UPSTREAM: &str = "ITMergeDateTimeRefiner";

pub fn create(_flags: &Flags) -> Box<dyn Refiner> {
    Box::new(Merging::new(MergeDateTime(ItMergeDateTimeRefiner)))
}

struct ItMergeDateTimeRefiner;

impl MergeDateTimePattern for ItMergeDateTimeRefiner {
    fn pattern_between(&self) -> &JsRegex {
        js_regex!(r"^\s*(T|alle?|dopo\s*le|prima\s*delle?|,|-|\.|∙|:)?\s*$")
    }
}
