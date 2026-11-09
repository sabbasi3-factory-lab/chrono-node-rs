//! upstream `locales/ar/parsers/ARTimeUnitAgoFormatParser.ts`.

use crate::calculation::duration::reverse_duration;
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::ParsingComponents;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::locales::ar::abstract_parser_with_word_boundary_checking::{
    left_right_boundary_inner_pattern, pattern_left_boundary,
};
use crate::locales::ar::constants::{parse_duration, TIME_UNITS_PATTERN};

pub const UPSTREAM: &str = "ARTimeUnitAgoFormatParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(ArTimeUnitAgoFormatParser))
}

struct ArTimeUnitAgoFormatParser;

impl WordBoundaryParser for ArTimeUnitAgoFormatParser {
    fn pattern_left_boundary(&self) -> &str {
        pattern_left_boundary()
    }

    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        left_right_boundary_inner_pattern(&format!(
            r"(?:(?:منذ|قبل)\s*({0})|({0})\s*(?:مضت|سابقاً))",
            *TIME_UNITS_PATTERN
        ))
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let time_units_text = match m.get(1) {
            Some(s) if !s.is_empty() => s,
            _ => m.get(2).unwrap_or(""),
        };
        let time_units = parse_duration(time_units_text);
        let mut output_time_units = reverse_duration(&time_units);
        Extracted::Components(ParsingComponents::create_relative_from_reference(
            context.reference,
            &mut output_time_units,
        ))
    }
}
