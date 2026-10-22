//! upstream `locales/en/parsers/ENTimeUnitAgoFormatParser.ts`.

use std::sync::LazyLock;

use crate::calculation::duration::reverse_duration;
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::ParsingComponents;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::locales::en::constants::{parse_duration, TIME_UNITS_NO_ABBR_PATTERN, TIME_UNITS_PATTERN};

pub const UPSTREAM: &str = "ENTimeUnitAgoFormatParser";

pub fn create(flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(EnTimeUnitAgoFormatParser {
        strict_mode: flags.get("strictMode"),
    }))
}

static PATTERN: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(
        &format!(r"({})\s{{0,5}}(?:ago|before|earlier)(?=\W|$)", *TIME_UNITS_PATTERN),
        "i",
    )
});

static STRICT_PATTERN: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(
        &format!(r"({})\s{{0,5}}(?:ago|before|earlier)(?=\W|$)", *TIME_UNITS_NO_ABBR_PATTERN),
        "i",
    )
});

struct EnTimeUnitAgoFormatParser {
    strict_mode: bool,
}

impl WordBoundaryParser for EnTimeUnitAgoFormatParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        if self.strict_mode { STRICT_PATTERN.clone() } else { PATTERN.clone() }
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let Some(duration) = m.get(1).and_then(parse_duration) else {
            return Extracted::None;
        };
        let mut reversed = reverse_duration(&duration);
        Extracted::Components(ParsingComponents::create_relative_from_reference(
            context.reference,
            &mut reversed,
        ))
    }
}
