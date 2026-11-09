//! upstream `locales/ar/parsers/ARMonthNameParser.ts`.

use std::sync::LazyLock;

use crate::calculation::years::find_year_closest_to_ref;
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::Component;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::pattern::{dict_get, dict_keys, match_any_pattern};
use crate::locales::ar::abstract_parser_with_word_boundary_checking::{
    left_right_boundary_inner_pattern, pattern_left_boundary,
};
use crate::locales::ar::constants::{parse_year, MONTH_DICTIONARY, YEAR_PATTERN};

pub const UPSTREAM: &str = "ARMonthNameParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(ArMonthNameParser))
}

static PATTERN: LazyLock<JsRegex> = LazyLock::new(|| {
    left_right_boundary_inner_pattern(&format!(
        concat!(
            r"(?:(?:في|خلال)\s*)?",
            r"(?:شهر\s*)?",
            r"({month})",
            r"(?:",
            r"(?:\s*(?:،|,)?\s*(?:سنة|عام)?\s*)",
            r"({year})",
            r")?",
        ),
        month = match_any_pattern(dict_keys(MONTH_DICTIONARY)),
        year = *YEAR_PATTERN
    ))
});

const MONTH_NAME_GROUP: usize = 1;
const YEAR_GROUP: usize = 2;

struct ArMonthNameParser;

impl WordBoundaryParser for ArMonthNameParser {
    fn pattern_left_boundary(&self) -> &str {
        pattern_left_boundary()
    }

    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        PATTERN.clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        // Immediately preceded by a number: an invalid date (e.g. "32 يناير")
        if crate::js_regex!(r"[0-9٠-٩]+\s*$", "").is_match(&context.text[..m.index]) {
            return Extracted::None;
        }

        let month_name = m.get(MONTH_NAME_GROUP).unwrap_or("").to_lowercase();
        let month = match dict_get(MONTH_DICTIONARY, &month_name) {
            Some(month) if month != 0 => month,
            _ => return Extracted::None,
        };

        let mut result = context.create_parsing_result(m.index, m.text(), None, None);
        result.start.imply(Component::Day, 1);
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
