//! upstream `locales/zh/hant/parsers/ZHHantDateParser.ts`.

use std::sync::LazyLock;

use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::Component;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::js::js_parse_int;
use crate::core::utils::pattern::dict_keys;
use crate::locales::zh_hant::constants::{zh_string_to_number, zh_string_to_year, NUMBER};

pub const UPSTREAM: &str = "ZHHantDateParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(ZhHantDateParser))
}

static PATTERN: LazyLock<JsRegex> = LazyLock::new(|| {
    let keys: String = dict_keys(NUMBER).collect::<Vec<_>>().join("");
    JsRegex::new(
        &format!(
            "(\\d{{2,4}}|[{keys}]{{4}}|[{keys}]{{2}})?\
             (?:\\s*)(?:年)?(?:[\\s|,|，]*)\
             (\\d{{1,2}}|[{keys}]{{1,2}})\
             (?:\\s*)(?:月)(?:\\s*)\
             (\\d{{1,2}}|[{keys}]{{1,2}})?\
             (?:\\s*)(?:日|號)?"
        ),
        "",
    )
});

const YEAR_GROUP: usize = 1;
const MONTH_GROUP: usize = 2;
const DAY_GROUP: usize = 3;

struct ZhHantDateParser;

impl WordBoundaryParser for ZhHantDateParser {
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
            Some(text) => {
                let day = js_parse_int(text).or_else(|| zh_string_to_number(text));
                result.start.assign(Component::Day, day.unwrap_or(0));
            }
            None => {
                result
                    .start
                    .imply(Component::Day, context.ref_date.get_date());
            }
        }

        match m.get(YEAR_GROUP).filter(|s| !s.is_empty()) {
            Some(text) => {
                let year = js_parse_int(text).or_else(|| zh_string_to_year(text));
                result.start.assign(Component::Year, year.unwrap_or(0));
            }
            None => {
                result
                    .start
                    .imply(Component::Year, context.ref_date.get_full_year());
            }
        }

        Extracted::Result(result)
    }
}
