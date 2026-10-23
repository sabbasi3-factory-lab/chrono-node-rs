//! upstream `locales/en/parsers/ENYearMonthNameParser.ts`.

use std::sync::LazyLock;

use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::Component;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::pattern::{dict_get, dict_keys, match_any_pattern};
use crate::locales::en::constants::{parse_year, MONTH_DICTIONARY};

pub const UPSTREAM: &str = "ENYearMonthNameParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(EnYearMonthNameParser))
}

const YEAR_PATTERN: &str = r"(?:[1-9][0-9]{0,3}\s{0,2}(?:BE|AD|BC|BCE|CE)|[1-9][0-9]{3})";

static PATTERN: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(
        &format!(
            concat!(
                r"({})",
                r"(?:\s*[-.\/,]?\s*|\s+of\s+)",
                r"({})",
                r"(?=[^\s\w]|\s+[^0-9]|\s+$|$)",
            ),
            YEAR_PATTERN,
            match_any_pattern(dict_keys(MONTH_DICTIONARY))
        ),
        "i",
    )
});

const YEAR_GROUP: usize = 1;
const MONTH_NAME_GROUP: usize = 2;

struct EnYearMonthNameParser;

impl WordBoundaryParser for EnYearMonthNameParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        PATTERN.clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let year = parse_year(m.get(YEAR_GROUP).unwrap_or(""));
        let month_name = m.get(MONTH_NAME_GROUP).unwrap_or("").to_lowercase();
        let month = dict_get(MONTH_DICTIONARY, &month_name).unwrap_or(0);

        let mut result = context.create_parsing_result(m.index, m.text().to_string(), None, None);
        result.start.imply(Component::Day, 1);
        result.start.assign(Component::Month, month);
        if let Some(year) = year {
            result.start.assign(Component::Year, year);
        }
        result.start.add_tag("parser/ENYearMonthNameParser");

        Extracted::Result(result)
    }
}
