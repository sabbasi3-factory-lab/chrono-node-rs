//! upstream `locales/vi/parsers/VIStandardParser.ts`.

use std::sync::LazyLock;

use crate::calculation::years::find_year_closest_to_ref;
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::Component;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::js::js_parse_int;
use crate::locales::vi::constants::{parse_year, YEAR_PATTERN};

pub const UPSTREAM: &str = "VIStandardParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(ViStandardParser))
}

// ngày 15 tháng 3 năm 1975  |  15 tháng 3 năm 1975  |  15 tháng 3
static PATTERN: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(
        &format!(r"(?:ngày\s*)?([0-9]{{1,2}})\s*tháng\s*([0-9]{{1,2}})(?:\s*năm\s*({}))?(?=\W|$)", YEAR_PATTERN),
        "i",
    )
});

const DAY_GROUP: usize = 1;
const MONTH_GROUP: usize = 2;
const YEAR_GROUP: usize = 3;

struct ViStandardParser;

impl WordBoundaryParser for ViStandardParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        PATTERN.clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        // Both groups are 1-2 digits, so `parseInt` never gives NaN here.
        let (Some(day), Some(month)) = (
            js_parse_int(m.get(DAY_GROUP).unwrap_or("")),
            js_parse_int(m.get(MONTH_GROUP).unwrap_or("")),
        ) else {
            return Extracted::None;
        };
        if day > 31 || month > 12 {
            return Extracted::None;
        }

        let mut result = context.create_parsing_result(m.index, m.text(), None, None);
        result.start.assign(Component::Day, day);
        result.start.assign(Component::Month, month);

        if let Some(year_text) = m.get(YEAR_GROUP).filter(|s| !s.is_empty()) {
            match parse_year(year_text) {
                Some(year) => {
                    result.start.assign(Component::Year, year);
                }
                None => return Extracted::None,
            }
        } else {
            result
                .start
                .imply(Component::Year, find_year_closest_to_ref(context.ref_date, day, month));
        }
        Extracted::Result(result)
    }
}
