//! upstream `locales/it/parsers/ITTimeUnitCasualRelativeFormatParser.ts`.

use std::sync::LazyLock;

use crate::calculation::duration::reverse_duration;
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::ParsingComponents;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::locales::it::constants::{parse_duration, TIME_UNITS_NO_ABBR_PATTERN, TIME_UNITS_PATTERN};

pub const UPSTREAM: &str = "ITTimeUnitCasualRelativeFormatParser";

pub fn create(flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(ItTimeUnitCasualRelativeFormatParser {
        allow_abbreviations: flags.get("allowAbbreviations"),
    }))
}

static PATTERN: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(
        &format!(
            r"(?:il\s*|la\s*|l'\s*)?(questo|questa|quest'|scorso|scorsa|prossimo|prossima|dopo|\+|-)\s*({})(?=\W|$)",
            *TIME_UNITS_PATTERN
        ),
        "i",
    )
});

static PATTERN_NO_ABBR: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(
        &format!(
            r"(?:il\s*|la\s*|l'\s*)?(questo|questa|quest'|scorso|scorsa|prossimo|prossima|dopo|\+|-)\s*({})(?=\W|$)",
            *TIME_UNITS_NO_ABBR_PATTERN
        ),
        "i",
    )
});

struct ItTimeUnitCasualRelativeFormatParser {
    allow_abbreviations: bool,
}

impl WordBoundaryParser for ItTimeUnitCasualRelativeFormatParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        if self.allow_abbreviations { PATTERN.clone() } else { PATTERN_NO_ABBR.clone() }
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let prefix = m.get(1).unwrap_or("").to_lowercase();
        let Some(mut duration) = parse_duration(m.get(2).unwrap_or("")) else {
            return Extracted::None;
        };
        if matches!(prefix.as_str(), "scorso" | "scorsa" | "-") {
            duration = reverse_duration(&duration);
        }
        Extracted::Components(ParsingComponents::create_relative_from_reference(
            context.reference,
            &mut duration,
        ))
    }
}
