//! upstream `locales/ru/parsers/RUCasualTimeParser.ts`.

use crate::common::casual_references as references;
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::js_regex;
use crate::locales::ru::abstract_parser_with_word_boundary_checking::{
    left_right_boundary_inner_pattern, pattern_left_boundary,
};

pub const UPSTREAM: &str = "RUCasualTimeParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(RuCasualTimeParser))
}

struct RuCasualTimeParser;

impl WordBoundaryParser for RuCasualTimeParser {
    fn pattern_left_boundary(&self) -> &str {
        pattern_left_boundary()
    }

    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        left_right_boundary_inner_pattern(
            r"(сейчас|прошлым\s*вечером|прошлой\s*ночью|следующей\s*ночью|сегодня\s*ночью|этой\s*ночью|ночью|этим утром|утром|утра|в\s*полдень|вечером|вечера|в\s*полночь)",
        )
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let lower_text = m.text().to_lowercase();
        let reference = context.reference;

        if lower_text == "сейчас" {
            return Extracted::Components(references::now(reference));
        }
        if lower_text == "вечером" || lower_text == "вечера" {
            return Extracted::Components(references::evening(reference, 20));
        }
        if lower_text.ends_with("утром") || lower_text.ends_with("утра") {
            return Extracted::Components(references::morning(reference, 6));
        }
        if js_regex!(r"в\s*полдень").is_match(&lower_text) {
            return Extracted::Components(references::noon(reference));
        }
        if js_regex!(r"прошлой\s*ночью").is_match(&lower_text) {
            return Extracted::Components(references::last_night(reference, 0));
        }
        if js_regex!(r"прошлым\s*вечером").is_match(&lower_text) {
            return Extracted::Components(references::yesterday_evening(reference, 20));
        }
        // Upstream's "следующей ночью" branch builds a component, but it then falls through
        // to the `endsWith("ночью")` check below and returns midnight, so it has no effect.
        if js_regex!(r"в\s*полночь").is_match(&lower_text) || lower_text.ends_with("ночью") {
            return Extracted::Components(references::midnight(reference));
        }
        Extracted::Components(context.create_parsing_components(&[]))
    }
}
