//! upstream `locales/ru/parsers/RUWeekdayParser.ts`.

use std::sync::LazyLock;

use crate::calculation::weekdays::{create_parsing_components_at_weekday, WeekdayModifier};
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::pattern::{dict_get, dict_keys, match_any_pattern};
use crate::locales::ru::abstract_parser_with_word_boundary_checking::{
    left_right_boundary_inner_pattern, pattern_left_boundary,
};
use crate::locales::ru::constants::WEEKDAY_DICTIONARY;

pub const UPSTREAM: &str = "RUWeekdayParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(RuWeekdayParser))
}

static PATTERN: LazyLock<JsRegex> = LazyLock::new(|| {
    left_right_boundary_inner_pattern(&format!(
        concat!(
            r"(?:(?:,|\(|（)\s*)?",
            r"(?:в\s*?)?",
            r"(?:(эту|этот|прошлый|прошлую|следующий|следующую|следующего)\s*)?",
            r"({})",
            r"(?:\s*(?:,|\)|）))?",
            r"(?:\s*на\s*(этой|прошлой|следующей)\s*неделе)?",
        ),
        match_any_pattern(dict_keys(WEEKDAY_DICTIONARY))
    ))
});

const PREFIX_GROUP: usize = 1;
const WEEKDAY_GROUP: usize = 2;
const POSTFIX_GROUP: usize = 3;

struct RuWeekdayParser;

impl WordBoundaryParser for RuWeekdayParser {
    fn pattern_left_boundary(&self) -> &str {
        pattern_left_boundary()
    }

    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        PATTERN.clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let day_of_week = m.get(WEEKDAY_GROUP).unwrap_or("").to_lowercase();
        let weekday = dict_get(WEEKDAY_DICTIONARY, &day_of_week).unwrap_or(0);
        // `prefix || postfix || ""`: an empty string is falsy in JS.
        let modifier_word = [m.get(PREFIX_GROUP), m.get(POSTFIX_GROUP)]
            .into_iter()
            .flatten()
            .find(|s| !s.is_empty())
            .unwrap_or("")
            .to_lowercase();

        let modifier = match modifier_word.as_str() {
            "прошлый" | "прошлую" | "прошлой" => Some(WeekdayModifier::Last),
            "следующий" | "следующую" | "следующей" | "следующего" => Some(WeekdayModifier::Next),
            "этот" | "эту" | "этой" => Some(WeekdayModifier::This),
            _ => None,
        };

        Extracted::Components(create_parsing_components_at_weekday(context.reference, weekday, modifier))
    }
}
