//! upstream `locales/uk/parsers/UKTimeUnitAgoFormatParser.ts`.

use crate::calculation::duration::reverse_duration;
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::ParsingComponents;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::locales::uk::abstract_parser_with_word_boundary_checking::{
    left_boundary_inner_pattern, pattern_left_boundary,
};
use crate::locales::uk::constants::{parse_duration, TIME_UNITS_PATTERN};

pub const UPSTREAM: &str = "UKTimeUnitAgoFormatParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(UkTimeUnitAgoFormatParser))
}

struct UkTimeUnitAgoFormatParser;

impl WordBoundaryParser for UkTimeUnitAgoFormatParser {
    fn pattern_left_boundary(&self) -> &str {
        pattern_left_boundary()
    }

    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        left_boundary_inner_pattern(&format!(r"({})\s{{0,5}}тому(?=(?:\W|$))", *TIME_UNITS_PATTERN))
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let time_units = parse_duration(m.get(1).unwrap_or(""));
        let mut output_time_units = reverse_duration(&time_units);
        Extracted::Components(ParsingComponents::create_relative_from_reference(
            context.reference,
            &mut output_time_units,
        ))
    }
}
