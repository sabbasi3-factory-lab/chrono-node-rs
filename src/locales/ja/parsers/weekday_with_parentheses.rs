//! upstream `locales/ja/parsers/JPWeekdayWithParenthesesParser.ts`.

use std::sync::LazyLock;

use crate::calculation::weekdays::create_parsing_components_at_weekday;
use crate::core::chrono::{Extracted, Parser};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::pattern::{dict_get, dict_keys};
use crate::locales::ja::constants::WEEKDAY_OFFSET;

pub const UPSTREAM: &str = "JPWeekdayWithParenthesesParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(JpWeekdayWithParenthesesParser)
}

// The `weekday` named group is group 1.
static PATTERN: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(
        &format!(
            r"(?:\(|\（)({})(?:\)|\）)",
            dict_keys(WEEKDAY_OFFSET).collect::<Vec<_>>().join("|")
        ),
        "i",
    )
});

struct JpWeekdayWithParenthesesParser;

impl Parser for JpWeekdayWithParenthesesParser {
    fn pattern(&self, _context: &ParsingContext) -> JsRegex {
        PATTERN.clone()
    }

    fn extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let day_of_week = m.get(1).unwrap_or("");
        let Some(offset) = dict_get(WEEKDAY_OFFSET, day_of_week) else {
            return Extracted::None;
        };
        Extracted::Components(create_parsing_components_at_weekday(
            context.reference,
            offset,
            None,
        ))
    }
}
