//! upstream `locales/it/parsers/ITTimeUnitLaterFormatParser.ts`.

use std::sync::LazyLock;

use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::ParsingComponents;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::locales::it::constants::{parse_duration, TIME_UNITS_NO_ABBR_PATTERN, TIME_UNITS_PATTERN};

pub const UPSTREAM: &str = "ITTimeUnitLaterFormatParser";

pub fn create(flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(ItTimeUnitLaterFormatParser { strict_mode: flags.get("strictMode") }))
}

static PATTERN: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(
        &format!(r"({})\s{{0,5}}(?:dopo|più\s*tardi|da\s*adesso|da\s*ora)(?=(?:\W|$))", *TIME_UNITS_PATTERN),
        "i",
    )
});

static STRICT_PATTERN: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(
        &format!(r"({})\s{{0,5}}(dopo|più\s*tardi|da\s*adesso|da\s*ora)(?=\W|$)", *TIME_UNITS_NO_ABBR_PATTERN),
        "i",
    )
});

const GROUP_NUM_TIMEUNITS: usize = 1;

struct ItTimeUnitLaterFormatParser {
    strict_mode: bool,
}

impl WordBoundaryParser for ItTimeUnitLaterFormatParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        if self.strict_mode { STRICT_PATTERN.clone() } else { PATTERN.clone() }
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let Some(mut time_units) = parse_duration(m.get(GROUP_NUM_TIMEUNITS).unwrap_or("")) else {
            return Extracted::None;
        };
        Extracted::Components(ParsingComponents::create_relative_from_reference(context.reference, &mut time_units))
    }
}
