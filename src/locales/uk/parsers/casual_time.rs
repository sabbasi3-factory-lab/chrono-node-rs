//! upstream `locales/uk/parsers/UKCasualTimeParser.ts`.

use crate::common::casual_references as references;
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::js_date::JsDate;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::dates::assign_similar_date;
use crate::js_regex;
use crate::locales::uk::abstract_parser_with_word_boundary_checking::{
    left_right_boundary_inner_pattern, pattern_left_boundary,
};

pub const UPSTREAM: &str = "UKCasualTimeParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(UkCasualTimeParser))
}

struct UkCasualTimeParser;

impl WordBoundaryParser for UkCasualTimeParser {
    fn pattern_left_boundary(&self) -> &str {
        pattern_left_boundary()
    }

    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        left_right_boundary_inner_pattern(
            r"(зараз|минулого\s*вечора|минулої\s*ночі|наступної\s*ночі|сьогодні\s*вночі|цієї\s*ночі|цього ранку|вранці|ранку|зранку|опівдні|ввечері|вечора|опівночі|вночі)",
        )
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let lower_text = m.text().to_lowercase();
        let reference = context.reference;
        let mut component = context.create_parsing_components(&[]);

        if lower_text == "зараз" {
            return Extracted::Components(references::now(reference));
        }
        if lower_text == "ввечері" || lower_text == "вечора" {
            return Extracted::Components(references::evening(reference, 20));
        }
        if lower_text.ends_with("вранці") || lower_text.ends_with("ранку") || lower_text.ends_with("зранку") {
            return Extracted::Components(references::morning(reference, 6));
        }
        if lower_text.ends_with("опівдні") {
            return Extracted::Components(references::noon(reference));
        }
        if js_regex!(r"минулої\s*ночі").is_match(&lower_text) {
            return Extracted::Components(references::last_night(reference, 0));
        }
        if js_regex!(r"минулого\s*вечора").is_match(&lower_text) {
            return Extracted::Components(references::yesterday_evening(reference, 20));
        }
        if js_regex!(r"наступної\s*ночі").is_match(&lower_text) {
            let target_date = context.ref_date;
            let days_to_add = if target_date.get_hours() < 22 { 1 } else { 2 };
            let mut next_day: JsDate = target_date;
            next_day.set_date(next_day.get_date() + days_to_add);
            assign_similar_date(&mut component, next_day);
            component.imply(crate::core::components::Component::Hour, 1);
        }
        if js_regex!(r"цієї\s*ночі").is_match(&lower_text) {
            return Extracted::Components(references::midnight(reference));
        }
        if lower_text.ends_with("опівночі") || lower_text.ends_with("вночі") {
            return Extracted::Components(references::midnight(reference));
        }
        Extracted::Components(component)
    }
}
