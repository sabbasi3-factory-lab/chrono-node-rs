//! upstream `locales/vi/refiners/VIMergeDateTimeRefiner.ts`.

use crate::common::abstract_refiners::Merging;
use crate::common::merge_date_time::{MergeDateTime, MergeDateTimePattern};
use crate::core::chrono::Refiner;
use crate::core::configuration::Flags;
use crate::core::regex::JsRegex;
use crate::js_regex;

pub const UPSTREAM: &str = "VIMergeDateTimeRefiner";

pub fn create(_flags: &Flags) -> Box<dyn Refiner> {
    Box::new(Merging::new(MergeDateTime(ViMergeDateTimeRefiner)))
}

struct ViMergeDateTimeRefiner;

impl MergeDateTimePattern for ViMergeDateTimeRefiner {
    fn pattern_between(&self) -> &JsRegex {
        js_regex!(r"^\s*(?:lúc|vào|,|T|-)?\s*$")
    }
}
