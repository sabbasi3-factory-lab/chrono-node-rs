//! upstream `locales/ar/parsers/ARTimeUnitLaterFormatParser.ts`.

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

pub const UPSTREAM: &str = "ARTimeUnitLaterFormatParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(ArTimeUnitLaterFormatParser))
}

struct ArTimeUnitLaterFormatParser;

impl WordBoundaryParser for ArTimeUnitLaterFormatParser {
    fn pattern_left_boundary(&self) -> &str {
        pattern_left_boundary()
    }

    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        left_right_boundary_inner_pattern(&format!(
            r"(?:(?:بعد)\s*({0})(?:\s*من\s*الآن)?|({0})\s*(?:من\s*الآن|لاحقاً|لاحقا))",
            *TIME_UNITS_PATTERN
        ))
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let time_units_text = match m.get(1) {
            Some(s) if !s.is_empty() => s,
            _ => m.get(2).unwrap_or(""),
        };
        let mut time_units = parse_duration(time_units_text);
        Extracted::Components(ParsingComponents::create_relative_from_reference(
            context.reference,
            &mut time_units,
        ))
    }
}
