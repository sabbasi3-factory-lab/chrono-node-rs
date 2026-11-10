//! upstream `locales/zh/hans/refiners/ZHHansMergeDateTimeRefiner.ts`.

use crate::common::abstract_refiners::Merging;
use crate::common::merge_date_time::{MergeDateTime, MergeDateTimePattern};
use crate::core::chrono::Refiner;
use crate::core::configuration::Flags;
use crate::core::regex::JsRegex;
use crate::js_regex;

pub const UPSTREAM: &str = "ZHHansMergeDateTimeRefiner";

pub fn create(_flags: &Flags) -> Box<dyn Refiner> {
    Box::new(Merging::new(MergeDateTime(ZhHansMergeDateTimeRefiner)))
}

struct ZhHansMergeDateTimeRefiner;

impl MergeDateTimePattern for ZhHansMergeDateTimeRefiner {
    fn pattern_between(&self) -> &JsRegex {
        js_regex!(r"^\s*$", "i")
    }
}
