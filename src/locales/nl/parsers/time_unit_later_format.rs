//! upstream `locales/nl/parsers/NLTimeUnitLaterFormatParser.ts`.

use std::sync::LazyLock;

use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::ParsingComponents;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::locales::nl::constants::{parse_duration, TIME_UNITS_PATTERN};

pub const UPSTREAM: &str = "NLTimeUnitLaterFormatParser";

pub fn create(flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(NlTimeUnitLaterFormatParser { strict_mode: flags.get("strictMode") }))
}

static PATTERN: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(&format!(r"({})(later|na|vanaf nu|voortaan|vooruit|uit)(?=(?:\W|$))", *TIME_UNITS_PATTERN), "i")
});

static STRICT_PATTERN: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new(&format!(r"({})(later|vanaf nu)(?=(?:\W|$))", *TIME_UNITS_PATTERN), "i"));

struct NlTimeUnitLaterFormatParser {
    strict_mode: bool,
}

impl WordBoundaryParser for NlTimeUnitLaterFormatParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        if self.strict_mode { STRICT_PATTERN.clone() } else { PATTERN.clone() }
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let mut time_units = parse_duration(m.get(1).unwrap_or(""));
        Extracted::Components(ParsingComponents::create_relative_from_reference(context.reference, &mut time_units))
    }
}
