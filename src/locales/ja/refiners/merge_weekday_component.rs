//! upstream `locales/ja/refiners/JPMergeWeekdayComponentRefiner.ts`.

use crate::common::abstract_refiners::{Merging, MergingRefiner};
use crate::core::chrono::Refiner;
use crate::core::components::Component;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::result::ParsingResult;

pub const UPSTREAM: &str = "JPMergeWeekdayComponentRefiner";

pub fn create(_flags: &Flags) -> Box<dyn Refiner> {
    Box::new(Merging::new(JpMergeWeekdayComponentRefiner))
}

struct JpMergeWeekdayComponentRefiner;

impl MergingRefiner for JpMergeWeekdayComponentRefiner {
    fn merge_results(
        &self,
        text_between: &str,
        current: ParsingResult,
        next: ParsingResult,
        _context: &ParsingContext,
    ) -> ParsingResult {
        let mut new_result = current.js_clone();
        new_result.text = format!("{}{}{}", current.text, text_between, next.text);

        let weekday = next.start.get(Component::Weekday);
        if let Some(w) = weekday {
            new_result.start.assign(Component::Weekday, w);
        }
        if let (Some(end), Some(w)) = (new_result.end.as_mut(), weekday) {
            end.assign(Component::Weekday, w);
        }

        new_result
    }

    fn should_merge_results(
        &self,
        text_between: &str,
        current: &ParsingResult,
        next: &ParsingResult,
        _context: &ParsingContext,
    ) -> bool {
        let normal_date_then_weekday = current.start.is_certain(Component::Day)
            && next.start.is_only_weekday_component()
            && !next.start.is_certain(Component::Hour);
        normal_date_then_weekday && crate::js_regex!(r"^[,、の]?\s*$").is_match(text_between)
    }
}
