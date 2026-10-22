//! upstream `locales/en/parsers/ENYearMonthDayParser.ts`.

use std::sync::LazyLock;

use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::Component;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::js::js_parse_int;
use crate::core::utils::pattern::{dict_get, dict_keys, match_any_pattern};
use crate::locales::en::constants::MONTH_DICTIONARY;

pub const UPSTREAM: &str = "ENYearMonthDayParser";

pub fn create(flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(EnYearMonthDayParser { strict_month_date_order: flags.get("strictMonthDateOrder") }))
}

static PATTERN: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(
        &format!(
            concat!(
                r"([0-9]{{4}})[-\.\/\s]",
                r"(?:({})|([0-9]{{1,2}}))[-\.\/\s]",
                r"([0-9]{{1,2}})",
                r"(?=\W|$)"
            ),
            match_any_pattern(dict_keys(MONTH_DICTIONARY))
        ),
        "i",
    )
});

const YEAR_NUMBER_GROUP: usize = 1;
const MONTH_NAME_GROUP: usize = 2;
const MONTH_NUMBER_GROUP: usize = 3;
const DATE_NUMBER_GROUP: usize = 4;

struct EnYearMonthDayParser {
    strict_month_date_order: bool,
}

impl WordBoundaryParser for EnYearMonthDayParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        PATTERN.clone()
    }

    fn inner_extract(&self, _context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let Some(year) = js_parse_int(m.get(YEAR_NUMBER_GROUP).unwrap_or("")) else {
            return Extracted::None;
        };
        let Some(mut day) = js_parse_int(m.get(DATE_NUMBER_GROUP).unwrap_or("")) else {
            return Extracted::None;
        };
        let mut month = if m.get(MONTH_NUMBER_GROUP).is_some_and(|s| !s.is_empty()) {
            js_parse_int(m.get(MONTH_NUMBER_GROUP).unwrap_or(""))
        } else {
            dict_get(MONTH_DICTIONARY, &m.get(MONTH_NAME_GROUP).unwrap_or("").to_lowercase())
        };

        if let Some(mo) = month {
            if !(1..=12).contains(&mo) {
                if self.strict_month_date_order {
                    return Extracted::None;
                }
                if (1..=12).contains(&day) {
                    month = Some(day);
                    day = mo;
                }
            }
        }
        if !(1..=31).contains(&day) {
            return Extracted::None;
        }
        let Some(month) = month else {
            return Extracted::None;
        };

        Extracted::Known(vec![(Component::Day, day), (Component::Month, month), (Component::Year, year)])
    }
}
