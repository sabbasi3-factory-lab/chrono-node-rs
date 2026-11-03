//! upstream `locales/fr/parsers/FRTimeUnitRelativeFormatParser.ts`.

use std::sync::LazyLock;

use crate::calculation::duration::{reverse_duration, Duration};
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::ParsingComponents;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::pattern::{dict_get, dict_keys, match_any_pattern};
use crate::js_regex;
use crate::locales::fr::constants::{parse_number_pattern, NUMBER_PATTERN, TIME_UNIT_DICTIONARY};

// Upstream's class in this file is named FRTimeUnitAgoFormatParser; the harness uses the file name.
pub const UPSTREAM: &str = "FRTimeUnitRelativeFormatParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(FrTimeUnitRelativeFormatParser))
}

const MODIFIER: &str = r"(prochaine?s?|derni[eè]re?s?|pass[ée]e?s?|pr[ée]c[ée]dents?|suivante?s?)";

static PATTERN: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(
        &format!(
            r"(?:les?|la|l'|du|des?)\s*({})?(?:\s*{})?\s*({})(?:\s*{})?(?=\W|$)",
            *NUMBER_PATTERN,
            MODIFIER,
            match_any_pattern(dict_keys(TIME_UNIT_DICTIONARY)),
            MODIFIER
        ),
        "i",
    )
});

struct FrTimeUnitRelativeFormatParser;

impl WordBoundaryParser for FrTimeUnitRelativeFormatParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        PATTERN.clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let num = match m.get(1) {
            Some(s) if !s.is_empty() => parse_number_pattern(s),
            _ => 1.0,
        };
        let unit = dict_get(TIME_UNIT_DICTIONARY, &m.get(3).unwrap_or("").to_lowercase());
        let mut time_units = Duration::new();
        if let Some(unit) = unit {
            time_units.set(unit, num);
        }

        let modifier = [m.get(2), m.get(4)]
            .into_iter()
            .flatten()
            .find(|s| !s.is_empty())
            .unwrap_or("")
            .to_lowercase();
        if modifier.is_empty() {
            return Extracted::None;
        }

        if js_regex!(r"derni[eè]re?s?").is_match(&modifier)
            || js_regex!(r"pass[ée]e?s?").is_match(&modifier)
            || js_regex!(r"pr[ée]c[ée]dents?").is_match(&modifier)
        {
            time_units = reverse_duration(&time_units);
        }

        Extracted::Components(ParsingComponents::create_relative_from_reference(
            context.reference,
            &mut time_units,
        ))
    }
}
