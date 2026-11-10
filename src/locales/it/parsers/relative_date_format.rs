//! upstream `locales/it/parsers/ITRelativeDateFormatParser.ts`.

use std::sync::LazyLock;

use crate::calculation::duration::Duration;
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::{Component, ParsingComponents};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::pattern::{dict_get, dict_keys, match_any_pattern};
use crate::js_regex;
use crate::locales::it::constants::TIME_UNIT_DICTIONARY;

pub const UPSTREAM: &str = "ITRelativeDateFormatParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(ItRelativeDateFormatParser))
}

// Italian uses "il mese prossimo" (article + noun + modifier) more commonly than "il prossimo mese"
static PATTERN: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(
        &format!(
            concat!(
                r"(?:",
                // Pattern 1: "il prossimo mese" / "la prossima settimana" (modifier before noun)
                r"(?:il\s*|la\s*|l'\s*)?(questo|questa|quest'|scorso|scorsa|prossimo|prossima|dopo\s*questo|dopo\s*questa)\s*({units})",
                r"|",
                // Pattern 2: "il mese prossimo" / "la settimana scorsa" (modifier after noun)
                r"(?:il\s*|la\s*|l'\s*)({units})\s*(scorso|scorsa|prossimo|prossima)",
                r")(?=\W|$)",
            ),
            units = match_any_pattern(dict_keys(TIME_UNIT_DICTIONARY))
        ),
        "i",
    )
});

// Pattern 1 groups
const MODIFIER_WORD_GROUP_1: usize = 1;
const RELATIVE_WORD_GROUP_1: usize = 2;
// Pattern 2 groups
const RELATIVE_WORD_GROUP_2: usize = 3;
const MODIFIER_WORD_GROUP_2: usize = 4;

struct ItRelativeDateFormatParser;

impl WordBoundaryParser for ItRelativeDateFormatParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        PATTERN.clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        // Determine which pattern matched
        let (modifier, unit_word) = if m.get(MODIFIER_WORD_GROUP_1).is_some_and(|s| !s.is_empty()) {
            // Pattern 1: "il prossimo mese"
            (
                m.get(MODIFIER_WORD_GROUP_1).unwrap_or("").to_lowercase(),
                m.get(RELATIVE_WORD_GROUP_1).unwrap_or("").to_lowercase(),
            )
        } else {
            // Pattern 2: "il mese prossimo"
            (
                m.get(MODIFIER_WORD_GROUP_2).unwrap_or("").to_lowercase(),
                m.get(RELATIVE_WORD_GROUP_2).unwrap_or("").to_lowercase(),
            )
        };

        let Some(timeunit) = dict_get(TIME_UNIT_DICTIONARY, &unit_word) else {
            return Extracted::None;
        };

        if modifier == "prossimo" || modifier == "prossima" || modifier.starts_with("dopo") {
            let mut units = Duration::from_pairs(&[(timeunit, 1.0)]);
            return Extracted::Components(ParsingComponents::create_relative_from_reference(
                context.reference,
                &mut units,
            ));
        }

        if modifier == "scorso" || modifier == "scorsa" {
            let mut units = Duration::from_pairs(&[(timeunit, -1.0)]);
            return Extracted::Components(ParsingComponents::create_relative_from_reference(
                context.reference,
                &mut units,
            ));
        }

        let mut components = context.create_parsing_components(&[]);
        let mut date = context.reference.instant;

        // Questa settimana
        if js_regex!(r"settimana", "i").is_match(&unit_word) {
            date.set_date(date.get_date() - date.get_day());
            components.imply(Component::Day, date.get_date());
            components.imply(Component::Month, date.get_month() + 1);
            components.imply(Component::Year, date.get_full_year());
        }
        // Questo mese
        else if js_regex!(r"mese", "i").is_match(&unit_word) {
            date.set_date(1);
            components.imply(Component::Day, date.get_date());
            components.assign(Component::Year, date.get_full_year());
            components.assign(Component::Month, date.get_month() + 1);
        }
        // Quest'anno
        else if js_regex!(r"anno", "i").is_match(&unit_word) {
            date.set_date(1);
            date.set_month(0);
            components.imply(Component::Day, date.get_date());
            components.imply(Component::Month, date.get_month() + 1);
            components.assign(Component::Year, date.get_full_year());
        }

        Extracted::Components(components)
    }
}
