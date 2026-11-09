//! upstream `locales/vi/parsers/VITimeUnitAgoFormatParser.ts`.

use std::sync::LazyLock;

use crate::calculation::duration::reverse_duration;
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::ParsingComponents;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::locales::vi::constants::{parse_duration, TIME_UNITS_PATTERN};

pub const UPSTREAM: &str = "VITimeUnitAgoFormatParser";

/// `strictMode` is unused upstream: VI has no unit abbreviations, so both patterns are the same.
pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(ViTimeUnitAgoFormatParser))
}

// 2 ngày trước  |  3 tháng qua  |  1 năm trước
static PATTERN: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new(&format!(r"({})\s{{0,5}}(?:trước|qua)(?=\W|$)", *TIME_UNITS_PATTERN), "i"));

struct ViTimeUnitAgoFormatParser;

impl WordBoundaryParser for ViTimeUnitAgoFormatParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        PATTERN.clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        // `if (!duration) return null` never fires: a duration is always an object.
        let duration = parse_duration(m.get(1).unwrap_or(""));
        let mut reversed = reverse_duration(&duration);
        Extracted::Components(ParsingComponents::create_relative_from_reference(
            context.reference,
            &mut reversed,
        ))
    }
}
