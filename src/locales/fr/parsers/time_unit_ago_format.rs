//! upstream `locales/fr/parsers/FRTimeUnitAgoFormatParser.ts`.

use std::sync::LazyLock;

use crate::calculation::duration::reverse_duration;
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::ParsingComponents;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::locales::fr::constants::{parse_duration, TIME_UNITS_PATTERN};

pub const UPSTREAM: &str = "FRTimeUnitAgoFormatParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(FrTimeUnitAgoFormatParser))
}

static PATTERN: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(&format!(r"il y a\s*({})(?=(?:\W|$))", *TIME_UNITS_PATTERN), "i")
});

struct FrTimeUnitAgoFormatParser;

impl WordBoundaryParser for FrTimeUnitAgoFormatParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        PATTERN.clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let duration = parse_duration(m.get(1).unwrap_or(""));
        let mut reversed = reverse_duration(&duration);
        Extracted::Components(ParsingComponents::create_relative_from_reference(
            context.reference,
            &mut reversed,
        ))
    }
}
