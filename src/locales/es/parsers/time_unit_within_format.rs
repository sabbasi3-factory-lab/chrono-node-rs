//! upstream `locales/es/parsers/ESTimeUnitWithinFormatParser.ts`.

use std::sync::LazyLock;

use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::ParsingComponents;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::locales::es::constants::{parse_duration, TIME_UNITS_PATTERN};

pub const UPSTREAM: &str = "ESTimeUnitWithinFormatParser";

pub fn create(flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(EsTimeUnitWithinFormatParser {
        strict_mode: flags.get("strictMode"),
    }))
}

static PATTERN_WITH_OPTIONAL_PREFIX: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(
        &format!(r"(?:(?:en|por|durante|de|dentro de)\s*)?({})(?=\W|$)", *TIME_UNITS_PATTERN),
        "i",
    )
});

static PATTERN_WITH_PREFIX: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(
        &format!(r"(?:en|por|durante|de|dentro de)\s*({})(?=\W|$)", *TIME_UNITS_PATTERN),
        "i",
    )
});

struct EsTimeUnitWithinFormatParser {
    strict_mode: bool,
}

impl WordBoundaryParser for EsTimeUnitWithinFormatParser {
    fn inner_pattern(&self, context: &ParsingContext) -> JsRegex {
        if !self.strict_mode && context.option.forward_date {
            PATTERN_WITH_OPTIONAL_PREFIX.clone()
        } else {
            PATTERN_WITH_PREFIX.clone()
        }
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let mut time_units = parse_duration(m.get(1).unwrap_or(""));
        Extracted::Components(ParsingComponents::create_relative_from_reference(
            context.reference,
            &mut time_units,
        ))
    }
}
