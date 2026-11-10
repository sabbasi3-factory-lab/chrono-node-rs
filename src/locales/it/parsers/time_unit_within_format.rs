//! upstream `locales/it/parsers/ITTimeUnitWithinFormatParser.ts`.

use std::sync::LazyLock;

use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::ParsingComponents;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::js_regex;
use crate::locales::it::constants::{parse_duration, TIME_UNITS_NO_ABBR_PATTERN, TIME_UNITS_PATTERN};

pub const UPSTREAM: &str = "ITTimeUnitWithinFormatParser";

pub fn create(flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(ItTimeUnitWithinFormatParser { strict_mode: flags.get("strictMode") }))
}

static PATTERN_WITH_OPTIONAL_PREFIX: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(
        &format!(
            r"(?:(?:entro|tra|fra|in|per)\s*)?(?:(?:circa|approssimativamente)\s*(?:~\s*)?)?({})(?=\W|$)",
            *TIME_UNITS_PATTERN
        ),
        "i",
    )
});

static PATTERN_WITH_PREFIX: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(
        &format!(
            r"(?:entro|tra|fra|in|per)\s*(?:(?:circa|approssimativamente)\s*(?:~\s*)?)?({})(?=\W|$)",
            *TIME_UNITS_PATTERN
        ),
        "i",
    )
});

static PATTERN_WITH_PREFIX_STRICT: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(
        &format!(
            r"(?:entro|tra|fra|in|per)\s*(?:(?:circa|approssimativamente)\s*(?:~\s*)?)?({})(?=\W|$)",
            *TIME_UNITS_NO_ABBR_PATTERN
        ),
        "i",
    )
});

struct ItTimeUnitWithinFormatParser {
    strict_mode: bool,
}

impl WordBoundaryParser for ItTimeUnitWithinFormatParser {
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
        // Exclude "per il/la unit" phases, e.g. "per l'anno"
        if js_regex!(r"^per\s*(il|la|l')\s*\w+").is_match(m.text()) {
            return Extracted::None;
        }
        let Some(mut time_units) = parse_duration(m.get(1).unwrap_or("")) else {
            return Extracted::None;
        };
        Extracted::Components(ParsingComponents::create_relative_from_reference(context.reference, &mut time_units))
    }
}
