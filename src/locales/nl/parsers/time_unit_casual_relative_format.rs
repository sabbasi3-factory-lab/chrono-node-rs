//! upstream `locales/nl/parsers/NLTimeUnitCasualRelativeFormatParser.ts`.

use std::sync::LazyLock;

use crate::calculation::duration::reverse_duration;
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::ParsingComponents;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::locales::nl::constants::{parse_duration, TIME_UNITS_PATTERN};

pub const UPSTREAM: &str = "NLTimeUnitCasualRelativeFormatParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(NlTimeUnitCasualRelativeFormatParser))
}

static PATTERN: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(
        &format!(r"(dit|deze|vorig|afgelopen|(?:aan)?komend|over|\+|-)e?\s*({})(?=\W|$)", *TIME_UNITS_PATTERN),
        "i",
    )
});

struct NlTimeUnitCasualRelativeFormatParser;

impl WordBoundaryParser for NlTimeUnitCasualRelativeFormatParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        PATTERN.clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let prefix = m.get(1).unwrap_or("").to_lowercase();
        let mut time_units = parse_duration(m.get(2).unwrap_or(""));
        if matches!(prefix.as_str(), "vorig" | "afgelopen" | "-") {
            time_units = reverse_duration(&time_units);
        }
        Extracted::Components(ParsingComponents::create_relative_from_reference(
            context.reference,
            &mut time_units,
        ))
    }
}
