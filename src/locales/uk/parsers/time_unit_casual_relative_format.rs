//! upstream `locales/uk/parsers/UKTimeUnitCasualRelativeFormatParser.ts`.

use crate::calculation::duration::reverse_duration;
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::ParsingComponents;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::locales::uk::abstract_parser_with_word_boundary_checking::{
    left_right_boundary_inner_pattern, pattern_left_boundary,
};
use crate::locales::uk::constants::{parse_duration, TIME_UNITS_PATTERN};

pub const UPSTREAM: &str = "UKTimeUnitCasualRelativeFormatParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(UkTimeUnitCasualRelativeFormatParser))
}

struct UkTimeUnitCasualRelativeFormatParser;

impl WordBoundaryParser for UkTimeUnitCasualRelativeFormatParser {
    fn pattern_left_boundary(&self) -> &str {
        pattern_left_boundary()
    }

    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        left_right_boundary_inner_pattern(&format!(
            r"(ці|останні|минулі|майбутні|наступні|після|через|\+|-)\s*({})",
            *TIME_UNITS_PATTERN
        ))
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let prefix = m.get(1).unwrap_or("").to_lowercase();
        // Upstream reads match[3]: the shift keeps the old last-but-one group in place.
        let mut time_units = parse_duration(m.get(3).unwrap_or(""));
        if matches!(prefix.as_str(), "останні" | "минулі" | "-") {
            time_units = reverse_duration(&time_units);
        }
        Extracted::Components(ParsingComponents::create_relative_from_reference(
            context.reference,
            &mut time_units,
        ))
    }
}
