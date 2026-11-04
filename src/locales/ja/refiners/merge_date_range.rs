//! upstream `locales/ja/refiners/JPMergeDateRangeRefiner.ts`.
//!
//! Merges before and after results: "2月11日ー2月13日", "水曜日から日曜日".

use crate::common::abstract_refiners::Merging;
use crate::common::merge_date_range::{MergeDateRange, MergeDateRangePattern};
use crate::core::chrono::Refiner;
use crate::core::configuration::Flags;
use crate::core::regex::JsRegex;
use crate::js_regex;

pub const UPSTREAM: &str = "JPMergeDateRangeRefiner";

pub fn create(_flags: &Flags) -> Box<dyn Refiner> {
    Box::new(Merging::new(MergeDateRange(JpMergeDateRangeRefiner)))
}

struct JpMergeDateRangeRefiner;

impl MergeDateRangePattern for JpMergeDateRangeRefiner {
    fn pattern_between(&self) -> &JsRegex {
        js_regex!(r"^\s*(から|－|ー|-|～|~)\s*$", "i")
    }
}
