//! upstream `locales/fr/parsers/FRWeekdayParser.ts`.

use std::sync::LazyLock;

use crate::calculation::weekdays::{create_parsing_components_at_weekday, WeekdayModifier};
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::pattern::{dict_get, dict_keys, match_any_pattern};
use crate::locales::fr::constants::WEEKDAY_DICTIONARY;

pub const UPSTREAM: &str = "FRWeekdayParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(FrWeekdayParser))
}

static PATTERN: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(
        &format!(
            concat!(
                r"(?:(?:\,|\(|\（)\s*)?",
                r"(?:(?:ce)\s*)?",
                r"({})",
                r"(?:\s*(?:\,|\)|\）))?",
                r"(?:\s*(dernier|prochain)\s*)?",
                r"(?=\W|\d|$)",
            ),
            match_any_pattern(dict_keys(WEEKDAY_DICTIONARY))
        ),
        "i",
    )
});

const WEEKDAY_GROUP: usize = 1;
const POSTFIX_GROUP: usize = 2;

struct FrWeekdayParser;

impl WordBoundaryParser for FrWeekdayParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        PATTERN.clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let day_of_week = m.get(WEEKDAY_GROUP).unwrap_or("").to_lowercase();
        let Some(weekday) = dict_get(WEEKDAY_DICTIONARY, &day_of_week) else {
            return Extracted::None;
        };

        let suffix = m.get(POSTFIX_GROUP).unwrap_or("").to_lowercase();
        let modifier = match suffix.as_str() {
            "dernier" => Some(WeekdayModifier::Last),
            "prochain" => Some(WeekdayModifier::Next),
            _ => None,
        };

        Extracted::Components(create_parsing_components_at_weekday(context.reference, weekday, modifier))
    }
}
