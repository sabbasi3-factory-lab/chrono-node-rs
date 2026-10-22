//! upstream `locales/en/parsers/ENTimeUnitWithinFormatParser.ts`.

use std::sync::LazyLock;

use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::ParsingComponents;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::locales::en::constants::{parse_duration, TIME_UNITS_NO_ABBR_PATTERN, TIME_UNITS_PATTERN};

pub const UPSTREAM: &str = "ENTimeUnitWithinFormatParser";

pub fn create(flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(EnTimeUnitWithinFormatParser {
        strict_mode: flags.get("strictMode"),
    }))
}

const OPTIONAL_ABOUT: &str = r"(?:(?:about|around|roughly|approximately|just)\s*(?:~\s*)?)?";

static PATTERN_WITH_OPTIONAL_PREFIX: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(
        &format!(r"(?:(?:within|in|for)\s*)?{}({})(?=\W|$)", OPTIONAL_ABOUT, *TIME_UNITS_PATTERN),
        "i",
    )
});

static PATTERN_WITH_PREFIX: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(
        &format!(r"(?:within|in|for)\s*{}({})(?=\W|$)", OPTIONAL_ABOUT, *TIME_UNITS_PATTERN),
        "i",
    )
});

static PATTERN_WITH_PREFIX_STRICT: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(
        &format!(r"(?:within|in|for)\s*{}({})(?=\W|$)", OPTIONAL_ABOUT, *TIME_UNITS_NO_ABBR_PATTERN),
        "i",
    )
});

static FOR_THE_UNIT: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new(r"^for\s*the\s*\w+", "i"));

struct EnTimeUnitWithinFormatParser {
    strict_mode: bool,
}

impl WordBoundaryParser for EnTimeUnitWithinFormatParser {
    fn inner_pattern(&self, context: &ParsingContext) -> JsRegex {
        if self.strict_mode {
            return PATTERN_WITH_PREFIX_STRICT.clone();
        }
        if context.option.forward_date {
            PATTERN_WITH_OPTIONAL_PREFIX.clone()
        } else {
            PATTERN_WITH_PREFIX.clone()
        }
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        // Exclude "for the unit" phases, e.g. "for the year"
        if FOR_THE_UNIT.is_match(m.text()) {
            return Extracted::None;
        }
        let Some(mut duration) = m.get(1).and_then(parse_duration) else {
            return Extracted::None;
        };
        Extracted::Components(ParsingComponents::create_relative_from_reference(
            context.reference,
            &mut duration,
        ))
    }
}
