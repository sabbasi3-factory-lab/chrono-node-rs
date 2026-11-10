//! upstream `locales/id/refiners/IDMergeDateTimeRefiner.ts`.
//!
//! Merges a date-only result and a time-only result: "Besok \[pukul\] 10.00", "17 Agustus 1945 \[,\] 10.00".

use crate::common::abstract_refiners::Merging;
use crate::common::merge_date_time::{MergeDateTime, MergeDateTimePattern};
use crate::core::chrono::Refiner;
use crate::core::configuration::Flags;
use crate::core::regex::JsRegex;
use crate::js_regex;

pub const UPSTREAM: &str = "IDMergeDateTimeRefiner";

pub fn create(_flags: &Flags) -> Box<dyn Refiner> {
    Box::new(Merging::new(MergeDateTime(IdMergeDateTimeRefiner)))
}

struct IdMergeDateTimeRefiner;

impl MergeDateTimePattern for IdMergeDateTimeRefiner {
    fn pattern_between(&self) -> &JsRegex {
        js_regex!(r"^\s*(?:pada|,|-|T)?\s*$", "i")
    }
}
