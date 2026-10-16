//! upstream `locales/en/refiners/ENMergeDateRangeRefiner.ts`.
//!
//! Merges "from" and "to" results into a range: "2020-02-13 [to] 2020-02-15", "Wednesday [-] Friday".

use crate::common::abstract_refiners::Merging;
use crate::common::merge_date_range::{MergeDateRange, MergeDateRangePattern};
use crate::core::chrono::Refiner;
use crate::core::configuration::Flags;
use crate::core::regex::JsRegex;
use crate::js_regex;

pub const UPSTREAM: &str = "ENMergeDateRangeRefiner";

pub fn create(_flags: &Flags) -> Box<dyn Refiner> {
    Box::new(Merging::new(MergeDateRange(EnMergeDateRangeRefiner)))
}

struct EnMergeDateRangeRefiner;

impl MergeDateRangePattern for EnMergeDateRangeRefiner {
    fn pattern_between(&self) -> &JsRegex {
        js_regex!(r"^\s*(to|-|–|until|through|till)\s*$", "i")
    }
}
