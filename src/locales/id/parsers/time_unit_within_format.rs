//! upstream `locales/id/parsers/IDTimeUnitWithinFormatParser.ts`.

use std::sync::LazyLock;

use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::ParsingComponents;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::locales::id::constants::{parse_duration, TIME_UNITS_PATTERN};

pub const UPSTREAM: &str = "IDTimeUnitWithinFormatParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(IdTimeUnitWithinFormatParser))
}

// dalam 3 hari  |  dalam waktu 2 minggu  |  dalam sejam
static PATTERN: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(
        &format!(r"(?:dalam\s+(?:waktu\s+)?)({})(?=\W|$)", *TIME_UNITS_PATTERN),
        "i",
    )
});

struct IdTimeUnitWithinFormatParser;

impl WordBoundaryParser for IdTimeUnitWithinFormatParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        PATTERN.clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let mut duration = parse_duration(m.get(1).unwrap_or(""));
        Extracted::Components(ParsingComponents::create_relative_from_reference(
            context.reference,
            &mut duration,
        ))
    }
}
