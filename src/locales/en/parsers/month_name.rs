//! upstream `locales/en/parsers/ENMonthNameParser.ts`.

use std::sync::LazyLock;

use crate::calculation::years::find_year_closest_to_ref;
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::Component;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::pattern::{dict_get, dict_keys, js_len, match_any_pattern};
use crate::locales::en::constants::{parse_year, FULL_MONTH_NAME_DICTIONARY, MONTH_DICTIONARY, YEAR_PATTERN};

pub const UPSTREAM: &str = "ENMonthNameParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(EnMonthNameParser))
}

static PATTERN: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(
        &format!(
            concat!(
                r"((?:in)\s*)?",
                r"({})",
                r"\s*",
                r"(?:",
                r"(?:,|-|of)?\s*({})?",
                r")?",
                r"(?=[^\s\w]|\s+[^0-9]|\s+$|$)",
            ),
            match_any_pattern(dict_keys(MONTH_DICTIONARY)),
            YEAR_PATTERN
        ),
        "i",
    )
});

const PREFIX_GROUP: usize = 1;
const MONTH_NAME_GROUP: usize = 2;
const YEAR_GROUP: usize = 3;

struct EnMonthNameParser;

impl WordBoundaryParser for EnMonthNameParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        PATTERN.clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let month_name = m.get(MONTH_NAME_GROUP).unwrap_or("").to_lowercase();

        // skip some unlikely words "jan", "mar", ..
        if js_len(m.text()) <= 3 && dict_get(FULL_MONTH_NAME_DICTIONARY, &month_name).is_none() {
            return Extracted::None;
        }

        let mut result = context.create_parsing_result_to(
            m.index + m.get(PREFIX_GROUP).unwrap_or("").len(),
            m.index + m.text().len(),
            None,
            None,
        );
        result.start.imply(Component::Day, 1);
        result.start.add_tag("parser/ENMonthNameParser");

        let month = dict_get(MONTH_DICTIONARY, &month_name).unwrap_or(0);
        result.start.assign(Component::Month, month);

        if let Some(y) = m.get(YEAR_GROUP).filter(|s| !s.is_empty()) {
            if let Some(year) = parse_year(y) {
                result.start.assign(Component::Year, year);
            }
        } else {
            let year = find_year_closest_to_ref(context.ref_date, 1, month);
            result.start.imply(Component::Year, year);
        }

        Extracted::Result(result)
    }
}
