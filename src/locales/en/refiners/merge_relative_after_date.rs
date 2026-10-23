//! upstream `locales/en/refiners/ENMergeRelativeAfterDateRefiner.ts`.
//!
//! Merges a relative date/time that comes after an absolute date: "[2020-02-13] [+2 weeks]".

use crate::calculation::duration::reverse_duration;
use crate::common::abstract_refiners::{Merging, MergingRefiner};
use crate::core::chrono::Refiner;
use crate::core::components::ParsingComponents;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::reference::ReferenceWithTimezone;
use crate::core::result::ParsingResult;
use crate::js_regex;
use crate::locales::en::constants::parse_duration;

pub const UPSTREAM: &str = "ENMergeRelativeAfterDateRefiner";

pub fn create(_flags: &Flags) -> Box<dyn Refiner> {
    Box::new(Merging::new(EnMergeRelativeAfterDateRefiner))
}

fn is_positive_following_reference(result: &ParsingResult) -> bool {
    js_regex!(r"^[+-]", "i").is_match(&result.text)
}

fn is_negative_following_reference(result: &ParsingResult) -> bool {
    js_regex!(r"^-", "i").is_match(&result.text)
}

struct EnMergeRelativeAfterDateRefiner;

impl MergingRefiner for EnMergeRelativeAfterDateRefiner {
    fn should_merge_results(
        &self,
        text_between: &str,
        _current: &ParsingResult,
        next: &ParsingResult,
        _context: &ParsingContext,
    ) -> bool {
        if !js_regex!(r"^\s*$", "i").is_match(text_between) {
            return false;
        }
        is_positive_following_reference(next) || is_negative_following_reference(next)
    }

    fn merge_results(
        &self,
        text_between: &str,
        current: ParsingResult,
        next: ParsingResult,
        _context: &ParsingContext,
    ) -> ParsingResult {
        let mut duration = parse_duration(&next.text).unwrap_or_default();
        if is_negative_following_reference(&next) {
            duration = reverse_duration(&duration);
        }

        let components = ParsingComponents::create_relative_from_reference(
            ReferenceWithTimezone::new(current.start.date(), None),
            &mut duration,
        );

        ParsingResult::new(
            current.reference,
            current.index,
            format!("{}{}{}", current.text, text_between, next.text),
            Some(components),
            None,
        )
    }
}
