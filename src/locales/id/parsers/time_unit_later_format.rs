//! upstream `locales/id/parsers/IDTimeUnitLaterFormatParser.ts`.

use std::sync::LazyLock;

use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::ParsingComponents;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::locales::id::constants::{parse_duration, TIME_UNITS_PATTERN};

pub const UPSTREAM: &str = "IDTimeUnitLaterFormatParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(IdTimeUnitLaterFormatParser))
}

static PATTERN: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(
        &format!(
            r"({})\s{{0,5}}(?:lagi|kemudian|setelahnya|sesudahnya|mendatang|ke\s*depan)(?=\W|$)",
            *TIME_UNITS_PATTERN
        ),
        "i",
    )
});

struct IdTimeUnitLaterFormatParser;

impl WordBoundaryParser for IdTimeUnitLaterFormatParser {
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
