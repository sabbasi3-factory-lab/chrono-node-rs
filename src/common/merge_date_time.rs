//! upstream `common/refiners/AbstractMergeDateTimeRefiner.ts`.
//!
//! Implement [`MergeDateTimePattern`] (the locale's connector pattern) and wrap it:
//! `Box::new(Merging::new(MergeDateTime(MyPattern)))`.

use crate::calculation::merging::merge_date_time_result;
use crate::common::abstract_refiners::MergingRefiner;
use crate::core::context::ParsingContext;
use crate::core::regex::JsRegex;
use crate::core::result::ParsingResult;
use crate::core::utils::js::js_trim;

/// upstream `patternBetween()`.
pub trait MergeDateTimePattern: Send + Sync {
    fn pattern_between(&self) -> &JsRegex;
}

pub struct MergeDateTime<P>(pub P);

impl<P: MergeDateTimePattern> MergingRefiner for MergeDateTime<P> {
    fn should_merge_results(
        &self,
        text_between: &str,
        current: &ParsingResult,
        next: &ParsingResult,
        _context: &ParsingContext,
    ) -> bool {
        let is_date_then_time = current.start.is_only_date() && next.start.is_only_time();
        let is_time_then_date = current.start.is_only_time() && next.start.is_only_date();
        // A bare ":" is only a connector in the "date:time" direction (e.g. "05/31/2024:14:15").
        if is_time_then_date && js_trim(text_between) == ":" {
            return false;
        }
        (is_date_then_time || is_time_then_date) && self.0.pattern_between().is_match(text_between)
    }

    fn merge_results(
        &self,
        text_between: &str,
        current: ParsingResult,
        next: ParsingResult,
        _context: &ParsingContext,
    ) -> ParsingResult {
        let mut result = if current.start.is_only_date() {
            merge_date_time_result(&current, &next)
        } else {
            merge_date_time_result(&next, &current)
        };
        result.index = current.index;
        result.text = format!("{}{}{}", current.text, text_between, next.text);
        result
    }
}
