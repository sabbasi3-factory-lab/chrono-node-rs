//! upstream `locales/vi/parsers/VIWeekdayParser.ts`.

use std::sync::LazyLock;

use crate::calculation::weekdays::{create_parsing_components_at_weekday, WeekdayModifier};
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::pattern::{dict_get, dict_keys, match_any_pattern};
use crate::locales::vi::constants::WEEKDAY_DICTIONARY;

pub const UPSTREAM: &str = "VIWeekdayParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(ViWeekdayParser))
}

static PATTERN: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(
        &format!(
            // 'sau khi' is a conjunction ("after when"): excluded via negative lookahead
            r"({})(?:\s*(này|tới|sau(?!\s*khi)|qua))?(?=\W|$)",
            match_any_pattern(dict_keys(WEEKDAY_DICTIONARY))
        ),
        "i",
    )
});

const WEEKDAY_GROUP: usize = 1;
const MODIFIER_GROUP: usize = 2;

struct ViWeekdayParser;

impl WordBoundaryParser for ViWeekdayParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        PATTERN.clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let dow_text = m.get(WEEKDAY_GROUP).unwrap_or("").to_lowercase();
        let Some(dow) = dict_get(WEEKDAY_DICTIONARY, &dow_text) else {
            return Extracted::None;
        };

        let mut modifier = None;
        if let Some(word) = m.get(MODIFIER_GROUP).filter(|s| !s.is_empty()) {
            let w = word.to_lowercase();
            if w.contains("tới") || w.contains("sau") {
                modifier = Some(WeekdayModifier::Next);
            } else if w.contains("qua") {
                modifier = Some(WeekdayModifier::Last);
            }
        }

        Extracted::Components(create_parsing_components_at_weekday(context.reference, dow, modifier))
    }
}
