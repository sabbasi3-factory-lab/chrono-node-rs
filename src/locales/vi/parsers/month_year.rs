//! upstream `locales/vi/parsers/VIMonthYearParser.ts`.

use std::sync::LazyLock;

use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::Component;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::pattern::{dict_get, dict_keys, match_any_pattern};
use crate::locales::vi::constants::{parse_year, MONTH_DICTIONARY, YEAR_PATTERN};

pub const UPSTREAM: &str = "VIMonthYearParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(ViMonthYearParser))
}

// tháng 3 năm 1975  |  tháng ba năm 1975  |  tháng chạp  |  tháng giêng/1975
static PATTERN: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(
        &format!(
            r"({})(?:\s*(?:năm|/)\s*({}))?(?=\W|$)",
            match_any_pattern(dict_keys(MONTH_DICTIONARY)),
            YEAR_PATTERN
        ),
        "i",
    )
});

const MONTH_GROUP: usize = 1;
const YEAR_GROUP: usize = 2;

struct ViMonthYearParser;

impl WordBoundaryParser for ViMonthYearParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        PATTERN.clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        // `if (!month) return null`: no month is 0, so only a missing key fails.
        let Some(month) = dict_get(MONTH_DICTIONARY, &m.get(MONTH_GROUP).unwrap_or("").to_lowercase()) else {
            return Extracted::None;
        };

        let mut result = context.create_parsing_result(m.index, m.text(), None, None);
        result.start.assign(Component::Month, month);
        result.start.imply(Component::Day, 1);
        if let Some(year_text) = m.get(YEAR_GROUP).filter(|s| !s.is_empty()) {
            match parse_year(year_text) {
                Some(year) => {
                    result.start.assign(Component::Year, year);
                }
                // `assign("year", NaN)`: the year group is digits, so this can't happen.
                None => return Extracted::None,
            }
        } else {
            result.start.imply(
                Component::Year,
                context.reference.get_date_with_adjusted_timezone().get_full_year(),
            );
        }
        Extracted::Result(result)
    }
}
