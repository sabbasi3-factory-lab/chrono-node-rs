//! upstream `locales/en/refiners/ENMergeDateTimeRefiner.ts`.
//!
//! Merges a date-only result and a time-only result: "2020-02-13 [at] 6pm", "Tomorrow [after] 7am".

use crate::common::abstract_refiners::Merging;
use crate::common::merge_date_time::{MergeDateTime, MergeDateTimePattern};
use crate::core::chrono::Refiner;
use crate::core::configuration::Flags;
use crate::core::regex::JsRegex;
use crate::js_regex;

pub const UPSTREAM: &str = "ENMergeDateTimeRefiner";

pub fn create(_flags: &Flags) -> Box<dyn Refiner> {
    Box::new(Merging::new(MergeDateTime(EnMergeDateTimeRefiner)))
}

struct EnMergeDateTimeRefiner;

impl MergeDateTimePattern for EnMergeDateTimeRefiner {
    fn pattern_between(&self) -> &JsRegex {
        js_regex!(r"^\s*(T|at|after|before|on|of|,|-|\.|∙|:)?\s*$")
    }
}
