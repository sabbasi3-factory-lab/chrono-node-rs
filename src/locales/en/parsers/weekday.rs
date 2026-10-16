//! upstream `locales/en/parsers/ENWeekdayParser.ts`.

use std::sync::LazyLock;

use crate::calculation::weekdays::{create_parsing_components_at_weekday, WeekdayModifier};
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::weekday;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::pattern::{dict_get, dict_keys, match_any_pattern};
use crate::locales::en::constants::WEEKDAY_DICTIONARY;

pub const UPSTREAM: &str = "ENWeekdayParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(EnWeekdayParser))
}

static PATTERN: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(
        &format!(
            concat!(
                r"(?:(?:\,|\(|\（)\s*)?",
                r"(?:on\s*?)?",
                r"(?:(this|last|past|next)\s*)?",
                r"({}|weekend|weekday)",
                r"(?:\s*(?:\,|\)|\）))?",
                r"(?:\s*(?:of\s*)?(this|last|past|next)\s*week)?",
                r"(?=\W|$)",
            ),
            match_any_pattern(dict_keys(WEEKDAY_DICTIONARY))
        ),
        "i",
    )
});

const PREFIX_GROUP: usize = 1;
const WEEKDAY_GROUP: usize = 2;
const POSTFIX_GROUP: usize = 3;

struct EnWeekdayParser;

impl WordBoundaryParser for EnWeekdayParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        PATTERN.clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        // `prefix || postfix || ""`: an empty string is falsy in JS.
        let modifier_word = [m.get(PREFIX_GROUP), m.get(POSTFIX_GROUP)]
            .into_iter()
            .flatten()
            .find(|s| !s.is_empty())
            .unwrap_or("")
            .to_lowercase();

        let modifier = match modifier_word.as_str() {
            "last" | "past" => Some(WeekdayModifier::Last),
            "next" => Some(WeekdayModifier::Next),
            "this" => Some(WeekdayModifier::This),
            _ => None,
        };

        let weekday_word = m.get(WEEKDAY_GROUP).unwrap_or("").to_lowercase();
        let weekday = if let Some(w) = dict_get(WEEKDAY_DICTIONARY, &weekday_word) {
            w
        } else if weekday_word == "weekend" {
            // 'This/next weekend' means the coming Saturday, 'last weekend' means last Sunday.
            if modifier == Some(WeekdayModifier::Last) {
                weekday::SUNDAY
            } else {
                weekday::SATURDAY
            }
        } else if weekday_word == "weekday" {
            // On a weekend reference: the coming Monday or last Friday.
            // On a weekday reference: the next/last working day.
            let ref_weekday = context.reference.get_date_with_adjusted_timezone().get_day();
            if ref_weekday == weekday::SUNDAY || ref_weekday == weekday::SATURDAY {
                if modifier == Some(WeekdayModifier::Last) {
                    weekday::FRIDAY
                } else {
                    weekday::MONDAY
                }
            } else {
                let mut w = ref_weekday - 1;
                w = if modifier == Some(WeekdayModifier::Last) { w - 1 } else { w + 1 };
                // JS `%` keeps the dividend's sign, like Rust's.
                (w % 5) + 1
            }
        } else {
            return Extracted::None;
        };

        Extracted::Components(create_parsing_components_at_weekday(context.reference, weekday, modifier))
    }
}
