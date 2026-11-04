//! upstream `locales/ja/refiners/JPMergeDateTimeRefiner.ts`.
//!
//! Merges a date-only result and a time-only result: "2020年2月13日の6時".

use crate::common::abstract_refiners::Merging;
use crate::common::merge_date_time::{MergeDateTime, MergeDateTimePattern};
use crate::core::chrono::Refiner;
use crate::core::configuration::Flags;
use crate::core::regex::JsRegex;
use crate::js_regex;

pub const UPSTREAM: &str = "JPMergeDateTimeRefiner";

pub fn create(_flags: &Flags) -> Box<dyn Refiner> {
    Box::new(Merging::new(MergeDateTime(JpMergeDateTimeRefiner)))
}

struct JpMergeDateTimeRefiner;

impl MergeDateTimePattern for JpMergeDateTimeRefiner {
    fn pattern_between(&self) -> &JsRegex {
        js_regex!(r"^\s*(の)?\s*$", "i")
    }
}
