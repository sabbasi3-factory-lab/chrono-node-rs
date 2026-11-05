//! upstream `locales/id/parsers/IDWeekdayParser.ts`.

use std::sync::LazyLock;

use crate::calculation::weekdays::{create_parsing_components_at_weekday, WeekdayModifier};
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::js::is_js_whitespace;
use crate::core::utils::pattern::{dict_get, dict_keys, match_any_pattern};
use crate::locales::id::constants::WEEKDAY_DICTIONARY;

pub const UPSTREAM: &str = "IDWeekdayParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(IdWeekdayParser))
}

static PATTERN: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(
        &format!(
            concat!(
                r"(?:pada\s+)?(hari\s+)?",
                r"({})",
                r"(?:\s+(?:(?:minggu|pekan)\s+)?(ini|depan|berikutnya|mendatang|yang\s+lalu|lalu|kemarin))?",
                r"(?=\W|$)",
            ),
            match_any_pattern(dict_keys(WEEKDAY_DICTIONARY))
        ),
        "i",
    )
});

const HARI_PREFIX_GROUP: usize = 1;
const WEEKDAY_GROUP: usize = 2;
const MODIFIER_GROUP: usize = 3;

struct IdWeekdayParser;

impl WordBoundaryParser for IdWeekdayParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        PATTERN.clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let weekday_word = m.get(WEEKDAY_GROUP).unwrap_or("").to_lowercase();

        // "minggu" also means "week", only accept it as Sunday in "hari Minggu"
        if weekday_word == "minggu" && !m.get(HARI_PREFIX_GROUP).is_some_and(|s| !s.is_empty()) {
            return Extracted::None;
        }

        let Some(weekday) = dict_get(WEEKDAY_DICTIONARY, &weekday_word) else {
            return Extracted::None;
        };

        // `.replace(/\s+/g, " ")`
        let mut modifier_word = String::new();
        let mut in_space = false;
        for c in m.get(MODIFIER_GROUP).unwrap_or("").to_lowercase().chars() {
            if is_js_whitespace(c) {
                if !in_space {
                    modifier_word.push(' ');
                }
                in_space = true;
            } else {
                modifier_word.push(c);
                in_space = false;
            }
        }

        let modifier = match modifier_word.as_str() {
            "ini" => Some(WeekdayModifier::This),
            "depan" | "berikutnya" | "mendatang" => Some(WeekdayModifier::Next),
            "lalu" | "yang lalu" | "kemarin" => Some(WeekdayModifier::Last),
            _ => None,
        };

        Extracted::Components(create_parsing_components_at_weekday(context.reference, weekday, modifier))
    }
}
