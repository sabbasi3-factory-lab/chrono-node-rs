//! upstream `locales/ja/parsers/JPWeekdayParser.ts`.

use std::sync::LazyLock;

use crate::calculation::weekdays::{create_parsing_components_at_weekday, WeekdayModifier};
use crate::core::chrono::{Extracted, Parser};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::pattern::{dict_get, dict_keys};
use crate::locales::ja::constants::WEEKDAY_OFFSET;

pub const UPSTREAM: &str = "JPWeekdayParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(JpWeekdayParser)
}

// Groups: 1 = outer optional group, 2 = `prefix`, 3 = `weekday`.
static PATTERN: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(
        &format!(
            r"((前の|次の|今週))?({})(?:曜日|曜)",
            dict_keys(WEEKDAY_OFFSET).collect::<Vec<_>>().join("|")
        ),
        "i",
    )
});

struct JpWeekdayParser;

impl Parser for JpWeekdayParser {
    fn pattern(&self, _context: &ParsingContext) -> JsRegex {
        PATTERN.clone()
    }

    fn extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let day_of_week = m.get(3).unwrap_or("");
        let Some(offset) = dict_get(WEEKDAY_OFFSET, day_of_week) else {
            return Extracted::None;
        };

        let prefix = m.get(2).unwrap_or("");

        let modifier = if prefix.contains("前の") {
            Some(WeekdayModifier::Last)
        } else if prefix.contains("次の") {
            Some(WeekdayModifier::Next)
        } else if prefix.contains("今週") {
            Some(WeekdayModifier::This)
        } else {
            None
        };

        Extracted::Components(create_parsing_components_at_weekday(
            context.reference,
            offset,
            modifier,
        ))
    }
}
