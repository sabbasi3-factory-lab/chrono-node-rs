//! upstream `locales/fi/parsers/FIWeekdayParser.ts`.

use std::sync::LazyLock;

use crate::calculation::weekdays::{create_parsing_components_at_weekday, WeekdayModifier};
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::pattern::{dict_get, dict_keys, match_any_pattern};
use crate::locales::fi::constants::WEEKDAY_DICTIONARY;

pub const UPSTREAM: &str = "FIWeekdayParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(FiWeekdayParser))
}

static PATTERN: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(
        &format!(
            concat!(
                r"(?:(?:\,|\(|\（)\s*)?",
                r"(?:(viime|edellinen|edellisenä|ensi|seuraava|seuraavana|tämä|tänä)\s*)?",
                r"({})",
                r"(?:\s*(?:\,|\)|\）))?",
                r"(?:\s*(viime|ensi|seuraava)\s*viikolla)?",
                r"(?=\W|$)",
            ),
            match_any_pattern(dict_keys(WEEKDAY_DICTIONARY))
        ),
        "i",
    )
});

const PREFIX_GROUP: usize = 1;
const WEEKDAY_GROUP: usize = 2;
const SUFFIX_GROUP: usize = 3;

struct FiWeekdayParser;

impl WordBoundaryParser for FiWeekdayParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        PATTERN.clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let day_of_week = m.get(WEEKDAY_GROUP).unwrap_or("").to_lowercase();
        let Some(offset) = dict_get(WEEKDAY_DICTIONARY, &day_of_week) else {
            return Extracted::None;
        };

        // `prefix || postfix || ""`: an empty string is falsy in JS.
        let modifier_word = [m.get(PREFIX_GROUP), m.get(SUFFIX_GROUP)]
            .into_iter()
            .flatten()
            .find(|s| !s.is_empty())
            .unwrap_or("")
            .to_lowercase();

        let modifier = if ["viime", "edellinen", "edellisenä"].iter().any(|w| modifier_word.contains(w)) {
            Some(WeekdayModifier::Last)
        } else if ["ensi", "seuraava", "seuraavana"].iter().any(|w| modifier_word.contains(w)) {
            Some(WeekdayModifier::Next)
        } else {
            None
        };

        Extracted::Components(create_parsing_components_at_weekday(context.reference, offset, modifier))
    }
}
