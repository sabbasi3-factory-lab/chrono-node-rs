//! upstream `locales/ar/refiners/ARMergeDateRangeRefiner.ts`.
//!
//! Merges "from" and "to" results into a range: "من 15 يناير [إلى] 20 يناير", "من الأحد [وحتى] الخميس".

use crate::common::abstract_refiners::Merging;
use crate::common::merge_date_range::{MergeDateRange, MergeDateRangePattern};
use crate::core::chrono::Refiner;
use crate::core::configuration::Flags;
use crate::core::regex::JsRegex;
use crate::js_regex;

pub const UPSTREAM: &str = "ARMergeDateRangeRefiner";

pub fn create(_flags: &Flags) -> Box<dyn Refiner> {
    Box::new(Merging::new(MergeDateRange(ArMergeDateRangeRefiner)))
}

struct ArMergeDateRangeRefiner;

impl MergeDateRangePattern for ArMergeDateRangeRefiner {
    fn pattern_between(&self) -> &JsRegex {
        js_regex!(r"^\s*(إلى|وحتى|حتى|-|–)\s*$", "iu")
    }
}
