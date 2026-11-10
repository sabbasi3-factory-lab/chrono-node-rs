//! upstream `locales/it/parsers/ITWeekdayParser.ts`.

use std::sync::LazyLock;

use crate::calculation::weekdays::{create_parsing_components_at_weekday, WeekdayModifier};
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::weekday;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::pattern::{dict_get, dict_keys, match_any_pattern};
use crate::js_regex;
use crate::locales::it::constants::WEEKDAY_DICTIONARY;

pub const UPSTREAM: &str = "ITWeekdayParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(ItWeekdayParser))
}

static PATTERN: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(
        &format!(
            concat!(
                r"(?:(?:\,|\(|\（)\s*)?",
                r"(?:(questo|questa|quest'|scorso|scorsa|prossimo|prossima)\s*)?",
                r"({}|weekend|fine\s*settimana)",
                r"(?:\s*(?:\,|\)|\）))?",
                r"(?:\s*(scorso|scorsa|prossimo|prossima)(?:\s*settimana)?)?",
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

struct ItWeekdayParser;

impl WordBoundaryParser for ItWeekdayParser {
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
            "scorso" | "scorsa" => Some(WeekdayModifier::Last),
            "prossimo" | "prossima" => Some(WeekdayModifier::Next),
            "questo" | "questa" | "quest'" => Some(WeekdayModifier::This),
            _ => None,
        };

        let weekday_word = m.get(WEEKDAY_GROUP).unwrap_or("").to_lowercase();
        let weekday = if let Some(w) = dict_get(WEEKDAY_DICTIONARY, &weekday_word) {
            w
        } else if weekday_word == "weekend" || js_regex!(r"fine\s*settimana").is_match(&weekday_word) {
            // 'Questo/prossimo weekend' means the coming Saturday, 'scorso weekend' means last Sunday.
            if modifier == Some(WeekdayModifier::Last) { weekday::SUNDAY } else { weekday::SATURDAY }
        } else {
            return Extracted::None;
        };

        Extracted::Components(create_parsing_components_at_weekday(context.reference, weekday, modifier))
    }
}
