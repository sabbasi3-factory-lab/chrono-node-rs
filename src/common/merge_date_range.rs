//! upstream `common/refiners/AbstractMergeDateRangeRefiner.ts`.
//!
//! Implement [`MergeDateRangePattern`] and wrap it: `Box::new(Merging::new(MergeDateRange(MyPattern)))`.

use crate::calculation::duration::{add_duration, Duration, DurationUnit};
use crate::common::abstract_refiners::MergingRefiner;
use crate::core::components::Component;
use crate::core::context::ParsingContext;
use crate::core::js_date::JsDate;
use crate::core::regex::JsRegex;
use crate::core::result::ParsingResult;

/// upstream `patternBetween()`.
pub trait MergeDateRangePattern: Send + Sync {
    fn pattern_between(&self) -> &JsRegex;
}

pub struct MergeDateRange<P>(pub P);

/// JS `a > b` on dates (false when either is NaN).
fn gt(a: JsDate, b: JsDate) -> bool {
    matches!((a.get_time(), b.get_time()), (Some(a), Some(b)) if a > b)
}

fn plus(date: JsDate, unit: DurationUnit, amount: f64) -> JsDate {
    add_duration(date, &mut Duration::from_pairs(&[(unit, amount)]))
}

impl<P: MergeDateRangePattern> MergingRefiner for MergeDateRange<P> {
    fn should_merge_results(
        &self,
        text_between: &str,
        current: &ParsingResult,
        next: &ParsingResult,
        _context: &ParsingContext,
    ) -> bool {
        current.end.is_none() && next.end.is_none() && self.0.pattern_between().is_match(text_between)
    }

    fn merge_results(
        &self,
        text_between: &str,
        current: ParsingResult,
        next: ParsingResult,
        _context: &ParsingContext,
    ) -> ParsingResult {
        let (mut from, mut to) = (current, next);
        if !from.start.is_only_weekday_component() && !to.start.is_only_weekday_component() {
            for key in to.start.get_certain_components() {
                if !from.start.is_certain(key) {
                    from.start.imply(key, to.start.get_or_zero(key));
                }
            }
            for key in from.start.get_certain_components() {
                if !to.start.is_certain(key) {
                    to.start.imply(key, from.start.get_or_zero(key));
                }
            }
        }

        if gt(from.start.date(), to.start.date()) {
            let mut from_date = from.start.date();
            let mut to_date = to.start.date();
            if to.start.is_only_weekday_component() && gt(plus(to_date, DurationUnit::Day, 7.0), from_date) {
                to_date = plus(to_date, DurationUnit::Day, 7.0);
                to.start.imply(Component::Day, to_date.get_date());
                to.start.imply(Component::Month, to_date.get_month() + 1);
                to.start.imply(Component::Year, to_date.get_full_year());
            } else if from.start.is_only_weekday_component() && gt(to_date, plus(from_date, DurationUnit::Day, -7.0)) {
                from_date = plus(from_date, DurationUnit::Day, -7.0);
                from.start.imply(Component::Day, from_date.get_date());
                from.start.imply(Component::Month, from_date.get_month() + 1);
                from.start.imply(Component::Year, from_date.get_full_year());
            } else if to.start.is_date_with_unknown_year() && gt(plus(to_date, DurationUnit::Year, 1.0), from_date) {
                to_date = plus(to_date, DurationUnit::Year, 1.0);
                to.start.imply(Component::Year, to_date.get_full_year());
            } else if from.start.is_date_with_unknown_year() && gt(to_date, plus(from_date, DurationUnit::Year, -1.0)) {
                from_date = plus(from_date, DurationUnit::Year, -1.0);
                from.start.imply(Component::Year, from_date.get_full_year());
            } else {
                std::mem::swap(&mut from, &mut to);
            }
        }

        let mut result = from.js_clone();
        result.start = from.start.clone();
        result.end = Some(to.start.clone());
        result.index = from.index.min(to.index);
        result.text = if from.index < to.index {
            format!("{}{}{}", from.text, text_between, to.text)
        } else {
            format!("{}{}{}", to.text, text_between, from.text)
        };
        result
    }
}
