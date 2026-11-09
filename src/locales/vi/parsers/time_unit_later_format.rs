//! upstream `locales/vi/parsers/VITimeUnitLaterFormatParser.ts`.

use std::sync::LazyLock;

use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::ParsingComponents;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::locales::vi::constants::{parse_duration, TIME_UNITS_PATTERN};

pub const UPSTREAM: &str = "VITimeUnitLaterFormatParser";

/// `strictMode` is unused upstream: VI has no unit abbreviations, so both patterns are the same.
pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(ViTimeUnitLaterFormatParser))
}

// 2 ngày sau  |  3 tuần nữa  |  1 tháng tới
static PATTERN: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(&format!(r"({})\s{{0,5}}(?:sau|nữa|tới|tiếp)(?=\W|$)", *TIME_UNITS_PATTERN), "i")
});

struct ViTimeUnitLaterFormatParser;

impl WordBoundaryParser for ViTimeUnitLaterFormatParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        PATTERN.clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        // `if (!duration) return null` never fires: a duration is always an object.
        let mut duration = parse_duration(m.get(1).unwrap_or(""));
        Extracted::Components(ParsingComponents::create_relative_from_reference(
            context.reference,
            &mut duration,
        ))
    }
}
