//! upstream `locales/uk/parsers/UKWeekdayParser.ts`.

use std::sync::LazyLock;

use crate::calculation::weekdays::{create_parsing_components_at_weekday, WeekdayModifier};
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::pattern::{dict_get, dict_keys, match_any_pattern};
use crate::locales::uk::abstract_parser_with_word_boundary_checking::{
    left_right_boundary_inner_pattern, pattern_left_boundary,
};
use crate::locales::uk::constants::WEEKDAY_DICTIONARY;

pub const UPSTREAM: &str = "UKWeekdayParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(UkWeekdayParser))
}

static PATTERN: LazyLock<JsRegex> = LazyLock::new(|| {
    left_right_boundary_inner_pattern(&format!(
        concat!(
            r"(?:(?:,|\(|（)\s*)?",
            r"(?:в\s*?)?",
            r"(?:у\s*?)?",
            r"(?:(цей|минулого|минулий|попередній|попереднього|наступного|наступний|наступному)\s*)?",
            r"({})",
            r"(?:\s*(?:,|\)|）))?",
            r"(?:\s*(на|у|в)\s*(цьому|минулому|наступному)\s*тижні)?",
        ),
        match_any_pattern(dict_keys(WEEKDAY_DICTIONARY))
    ))
});

const PREFIX_GROUP: usize = 1;
const WEEKDAY_GROUP: usize = 2;
const POSTFIX_GROUP: usize = 3;

struct UkWeekdayParser;

impl WordBoundaryParser for UkWeekdayParser {
    fn pattern_left_boundary(&self) -> &str {
        pattern_left_boundary()
    }

    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        PATTERN.clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let day_of_week = m.get(WEEKDAY_GROUP).unwrap_or("").to_lowercase();
        let Some(weekday) = dict_get(WEEKDAY_DICTIONARY, &day_of_week) else {
            return Extracted::None;
        };
        // `prefix || postfix || ""`: an empty string is falsy in JS.
        let modifier_word = [m.get(PREFIX_GROUP), m.get(POSTFIX_GROUP)]
            .into_iter()
            .flatten()
            .find(|s| !s.is_empty())
            .unwrap_or("")
            .to_lowercase();

        let modifier = match modifier_word.as_str() {
            "минулого" | "минулий" | "попередній" | "попереднього" => Some(WeekdayModifier::Last),
            "наступного" | "наступний" => Some(WeekdayModifier::Next),
            "цей" | "цього" | "цьому" => Some(WeekdayModifier::This),
            _ => None,
        };

        Extracted::Components(create_parsing_components_at_weekday(context.reference, weekday, modifier))
    }
}
