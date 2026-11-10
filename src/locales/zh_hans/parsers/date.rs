//! upstream `locales/zh/hans/parsers/ZHHansDateParser.ts`.

use std::sync::LazyLock;

use super::super::constants::{zh_string_to_number, zh_string_to_year, NUMBER};
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::Component;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::js::js_parse_int;

pub const UPSTREAM: &str = "ZHHansDateParser";

const YEAR_GROUP: usize = 1;
const MONTH_GROUP: usize = 2;
const DAY_GROUP: usize = 3;

static PATTERN: LazyLock<JsRegex> = LazyLock::new(|| {
    let keys: String = NUMBER.iter().map(|(k, _)| *k).collect();
    JsRegex::new(
        &format!(
            concat!(
                r"(\d{{2,4}}|[{k}]{{4}}|[{k}]{{2}})?",
                r"(?:\s*)",
                r"(?:年)?",
                r"(?:[\s|,|，]*)",
                r"(\d{{1,2}}|[{k}]{{1,3}})",
                r"(?:\s*)",
                r"(?:月)",
                r"(?:\s*)",
                r"(\d{{1,2}}|[{k}]{{1,3}})?",
                r"(?:\s*)",
                r"(?:日|号)?"
            ),
            k = keys
        ),
        "",
    )
});

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(ZhHansDateParser))
}

struct ZhHansDateParser;

impl WordBoundaryParser for ZhHansDateParser {
    // A capturing group keeps the match index correct without treating CJK characters as boundaries.
    fn pattern_left_boundary(&self) -> &str {
        "()"
    }

    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        PATTERN.clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let mut result = context.create_parsing_result(m.index, m.text(), None, None);

        let month_text = m.get(MONTH_GROUP).unwrap_or("");
        let month = js_parse_int(month_text).or_else(|| zh_string_to_number(month_text));
        result.start.assign(Component::Month, month.unwrap_or(0));

        match m.get(DAY_GROUP).filter(|s| !s.is_empty()) {
            Some(day_text) => {
                let day = js_parse_int(day_text).or_else(|| zh_string_to_number(day_text));
                result.start.assign(Component::Day, day.unwrap_or(0));
            }
            None => {
                result.start.imply(Component::Day, context.ref_date.get_date());
            }
        }

        match m.get(YEAR_GROUP).filter(|s| !s.is_empty()) {
            Some(year_text) => {
                let year = js_parse_int(year_text).or_else(|| zh_string_to_year(year_text));
                result.start.assign(Component::Year, year.unwrap_or(0));
            }
            None => {
                result.start.imply(Component::Year, context.ref_date.get_full_year());
            }
        }

        Extracted::Result(result)
    }
}
