//! upstream `locales/nl/refiners/NLMergeDateTimeRefiner.ts`.
//!
//! Merges a date-only result and a time-only result: "2020-02-13 om 6pm".

use crate::common::abstract_refiners::Merging;
use crate::common::merge_date_time::{MergeDateTime, MergeDateTimePattern};
use crate::core::chrono::Refiner;
use crate::core::configuration::Flags;
use crate::core::regex::JsRegex;
use crate::js_regex;

pub const UPSTREAM: &str = "NLMergeDateTimeRefiner";

pub fn create(_flags: &Flags) -> Box<dyn Refiner> {
    Box::new(Merging::new(MergeDateTime(NlMergeDateTimeRefiner)))
}

struct NlMergeDateTimeRefiner;

impl MergeDateTimePattern for NlMergeDateTimeRefiner {
    fn pattern_between(&self) -> &JsRegex {
        js_regex!(r"^\s*(om|na|voor|in de|,|-)?\s*$")
    }
}
