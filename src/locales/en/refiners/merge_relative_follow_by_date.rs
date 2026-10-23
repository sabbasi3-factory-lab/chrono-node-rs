//! upstream `locales/en/refiners/ENMergeRelativeFollowByDateRefiner.ts`.
//!
//! Merges a relative date/time that is followed by an absolute date: "[2 weeks before] [2020-02-13]".

use crate::calculation::duration::reverse_duration;
use crate::common::abstract_refiners::{Merging, MergingRefiner};
use crate::core::chrono::Refiner;
use crate::core::components::{Component, ParsingComponents};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::reference::ReferenceWithTimezone;
use crate::core::result::ParsingResult;
use crate::js_regex;
use crate::locales::en::constants::parse_duration;

pub const UPSTREAM: &str = "ENMergeRelativeFollowByDateRefiner";

pub fn create(_flags: &Flags) -> Box<dyn Refiner> {
    Box::new(Merging::new(EnMergeRelativeFollowByDateRefiner))
}

fn has_implied_earlier_reference_date(result: &ParsingResult) -> bool {
    js_regex!(r"\s+(before|from)$", "i").is_match(&result.text)
}

fn has_implied_later_reference_date(result: &ParsingResult) -> bool {
    js_regex!(r"\s+(after|since)$", "i").is_match(&result.text)
}

struct EnMergeRelativeFollowByDateRefiner;

impl MergingRefiner for EnMergeRelativeFollowByDateRefiner {
    fn should_merge_results(
        &self,
        text_between: &str,
        current: &ParsingResult,
        next: &ParsingResult,
        _context: &ParsingContext,
    ) -> bool {
        if !js_regex!(r"^\s*$", "i").is_match(text_between) {
            return false;
        }
        if !has_implied_earlier_reference_date(current) && !has_implied_later_reference_date(current) {
            return false;
        }
        let truthy = |c| next.start.get(c).is_some_and(|v| v != 0);
        truthy(Component::Day) && truthy(Component::Month) && truthy(Component::Year)
    }

    fn merge_results(
        &self,
        text_between: &str,
        current: ParsingResult,
        next: ParsingResult,
        _context: &ParsingContext,
    ) -> ParsingResult {
        let mut duration = parse_duration(&current.text).unwrap_or_default();
        if has_implied_earlier_reference_date(&current) {
            duration = reverse_duration(&duration);
        }

        let components = ParsingComponents::create_relative_from_reference(
            ReferenceWithTimezone::new(next.start.date(), None),
            &mut duration,
        );

        ParsingResult::new(
            next.reference,
            current.index,
            format!("{}{}{}", current.text, text_between, next.text),
            Some(components),
            None,
        )
    }
}
