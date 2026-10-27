//! upstream `common/refiners/MergeWeekdayComponentRefiner.ts`.

use crate::common::abstract_refiners::{MergingRefiner, Merging};
use crate::core::chrono::Refiner;
use crate::core::components::Component;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::result::ParsingResult;

pub const UPSTREAM: &str = "MergeWeekdayComponentRefiner";

pub fn create(_flags: &Flags) -> Box<dyn Refiner> {
    Box::new(Merging::new(MergeWeekdayComponentRefiner))
}

/// upstream `MergeWeekdayComponentRefiner`.
pub struct MergeWeekdayComponentRefiner;

impl MergingRefiner for MergeWeekdayComponentRefiner {
    fn merge_results(
        &self,
        text_between: &str,
        current: ParsingResult,
        next: ParsingResult,
        _context: &ParsingContext,
    ) -> ParsingResult {
        let mut new_result = next.js_clone();
        new_result.index = current.index;
        new_result.text = format!("{}{}{}", current.text, text_between, new_result.text);

        let weekday = current.start.get(Component::Weekday);
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
        let weekday_then_normal_date = current.start.is_only_weekday_component()
            && !current.start.is_certain(Component::Hour)
            && next.start.is_certain(Component::Day)
            && !next.start.tags().iter().any(|t| t == "result/relativeDate");
        weekday_then_normal_date && crate::js_regex!(r"^,?\s*$").is_match(text_between)
    }
}
