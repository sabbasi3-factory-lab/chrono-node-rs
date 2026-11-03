//! upstream `locales/de/parsers/DETimeUnitRelativeFormatParser.ts`.

use std::sync::LazyLock;

use crate::calculation::duration::{reverse_duration, Duration};
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::ParsingComponents;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::pattern::{dict_get, dict_keys, match_any_pattern};
use crate::locales::de::constants::{parse_number_pattern, NUMBER_PATTERN, TIME_UNIT_DICTIONARY};

// Upstream's file declares a class named DETimeUnitAgoFormatParser; the harness uses the file name.
pub const UPSTREAM: &str = "DETimeUnitRelativeFormatParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(DeTimeUnitRelativeFormatParser))
}

static PATTERN: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(
        &format!(
            r"(?:\s*((?:nächste|kommende|folgende|letzte|vergangene|vorige|vor(?:her|an)gegangene)(?:s|n|m|r)?|vor|in)\s*)?({})?(?:\s*(nächste|kommende|folgende|letzte|vergangene|vorige|vor(?:her|an)gegangene)(?:s|n|m|r)?)?\s*({})(?=\W|$)",
            *NUMBER_PATTERN,
            match_any_pattern(dict_keys(TIME_UNIT_DICTIONARY))
        ),
        "i",
    )
});

struct DeTimeUnitRelativeFormatParser;

impl WordBoundaryParser for DeTimeUnitRelativeFormatParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        PATTERN.clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let num = match m.get(2) {
            Some(s) if !s.is_empty() => parse_number_pattern(s),
            _ => 1.0,
        };
        let Some(unit) = dict_get(TIME_UNIT_DICTIONARY, &m.get(4).unwrap_or("").to_lowercase()) else {
            return Extracted::None;
        };
        let mut time_units = Duration::from_pairs(&[(unit, num)]);

        let modifier = [m.get(1), m.get(3)]
            .into_iter()
            .flatten()
            .find(|s| !s.is_empty())
            .unwrap_or("")
            .to_lowercase();
        if modifier.is_empty() {
            return Extracted::None;
        }

        if modifier.contains("vor") || modifier.contains("letzte") || modifier.contains("vergangen") {
            time_units = reverse_duration(&time_units);
        }

        Extracted::Components(ParsingComponents::create_relative_from_reference(
            context.reference,
            &mut time_units,
        ))
    }
}
