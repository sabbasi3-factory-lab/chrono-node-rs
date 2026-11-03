//! upstream `locales/fr/refiners/FRMergeDateTimeRefiner.ts`.
//!
//! Merges a date-only result and a time-only result: "13 février à 18h", "demain vers 7h".

use crate::common::abstract_refiners::Merging;
use crate::common::merge_date_time::{MergeDateTime, MergeDateTimePattern};
use crate::core::chrono::Refiner;
use crate::core::configuration::Flags;
use crate::core::regex::JsRegex;
use crate::js_regex;

pub const UPSTREAM: &str = "FRMergeDateTimeRefiner";

pub fn create(_flags: &Flags) -> Box<dyn Refiner> {
    Box::new(Merging::new(MergeDateTime(FrMergeDateTimeRefiner)))
}

struct FrMergeDateTimeRefiner;

impl MergeDateTimePattern for FrMergeDateTimeRefiner {
    fn pattern_between(&self) -> &JsRegex {
        js_regex!(r"^\s*(T|à|a|au|vers|de|,|-)?\s*$")
    }
}
