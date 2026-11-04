//! upstream `locales/fi/parsers/FITimeUnitCasualRelativeFormatParser.ts`.

use std::sync::LazyLock;

use crate::calculation::duration::reverse_duration;
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::ParsingComponents;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::locales::fi::constants::{parse_duration, TIME_UNITS_NO_ABBR_PATTERN, TIME_UNITS_PATTERN};

pub const UPSTREAM: &str = "FITimeUnitCasualRelativeFormatParser";

pub fn create(flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(FiTimeUnitCasualRelativeFormatParser {
        allow_abbreviations: flags.get("allowAbbreviations"),
    }))
}

static PATTERN: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(
        &format!(
            r"(seuraava|seuraavat|seuraavien|edellinen|edelliset|edellisten|viimeiset|viimeisten|kuluneet|kuluneiden|\+|-)\s*({})(?=\W|$)",
            *TIME_UNITS_PATTERN
        ),
        "i",
    )
});

static PATTERN_NO_ABBR: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(
        &format!(
            r"(seuraava|seuraavat|seuraavien|edellinen|edelliset|edellisten|viimeiset|viimeisten|kuluneet|kuluneiden|\+|-)\s*({})(?=\W|$)",
            *TIME_UNITS_NO_ABBR_PATTERN
        ),
        "i",
    )
});

struct FiTimeUnitCasualRelativeFormatParser {
    allow_abbreviations: bool,
}

impl WordBoundaryParser for FiTimeUnitCasualRelativeFormatParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        if self.allow_abbreviations { PATTERN.clone() } else { PATTERN_NO_ABBR.clone() }
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let prefix = m.get(1).unwrap_or("").to_lowercase();
        // Upstream's `parseDuration` never returns null, so `!duration` can't be true.
        let mut duration = parse_duration(m.get(2).unwrap_or(""));
        if matches!(prefix.as_str(), "edellinen" | "edelliset" | "edellisten" | "viimeiset" | "viimeisten" | "kuluneet" | "kuluneiden" | "-") {
            duration = reverse_duration(&duration);
        }
        Extracted::Components(ParsingComponents::create_relative_from_reference(
            context.reference,
            &mut duration,
        ))
    }
}
