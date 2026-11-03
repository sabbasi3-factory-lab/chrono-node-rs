//! upstream `locales/fr/refiners/FRMergeDateRangeRefiner.ts`.

use crate::common::abstract_refiners::Merging;
use crate::common::merge_date_range::{MergeDateRange, MergeDateRangePattern};
use crate::core::chrono::Refiner;
use crate::core::configuration::Flags;
use crate::core::regex::JsRegex;
use crate::js_regex;

pub const UPSTREAM: &str = "FRMergeDateRangeRefiner";

pub fn create(_flags: &Flags) -> Box<dyn Refiner> {
    Box::new(Merging::new(MergeDateRange(FrMergeDateRangeRefiner)))
}

struct FrMergeDateRangeRefiner;

impl MergeDateRangePattern for FrMergeDateRangeRefiner {
    fn pattern_between(&self) -> &JsRegex {
        js_regex!(r"^\s*(à|a|au|-)\s*$", "i")
    }
}
