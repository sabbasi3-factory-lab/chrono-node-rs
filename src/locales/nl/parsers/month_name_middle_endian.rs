//! upstream `locales/nl/parsers/NLMonthNameMiddleEndianParser.ts`.

use std::sync::LazyLock;

use crate::calculation::years::find_year_closest_to_ref;
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::Component;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::pattern::{dict_get, dict_keys, match_any_pattern};
use crate::locales::nl::constants::{
    parse_ordinal_number_pattern, parse_year, MONTH_DICTIONARY, ORDINAL_NUMBER_PATTERN, YEAR_PATTERN,
};

pub const UPSTREAM: &str = "NLMonthNameMiddleEndianParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(NlMonthNameMiddleEndianParser))
}

static PATTERN: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(
        &format!(
            concat!(
                r"(?:on\s*?)?",
                r"({ord})",
                r"(?:\s*",
                r"(?:tot|\-|\–|until|through|till|\s)\s*",
                r"({ord})",
                r")?",
                r"(?:-|/|\s*(?:of)?\s*)",
                r"(",
                r"{month}",
                r")",
                r"(?:",
                r"(?:-|/|,?\s*)",
                r"({year}(?![^\s]\d))",
                r")?",
                r"(?=\W|$)",
            ),
            month = match_any_pattern(dict_keys(MONTH_DICTIONARY)),
            ord = *ORDINAL_NUMBER_PATTERN,
            year = YEAR_PATTERN
        ),
        "i",
    )
});

const MONTH_NAME_GROUP: usize = 3;
const DATE_GROUP: usize = 1;
const DATE_TO_GROUP: usize = 2;
const YEAR_GROUP: usize = 4;

struct NlMonthNameMiddleEndianParser;

impl WordBoundaryParser for NlMonthNameMiddleEndianParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        PATTERN.clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let month = dict_get(MONTH_DICTIONARY, &m.get(MONTH_NAME_GROUP).unwrap_or("").to_lowercase()).unwrap_or(0);
        let date_text = m.get(DATE_GROUP).unwrap_or("");
        let day = parse_ordinal_number_pattern(date_text);
        if day.is_some_and(|d| d > 31) {
            // e.g. "[96 Aug]" => "9[6 Aug]", we need to shift away from the next number
            m.index += date_text.len();
            return Extracted::None;
        }

        let mut known = Vec::new();
        if let Some(d) = day {
            known.push((Component::Day, d));
        }
        known.push((Component::Month, month));
        let mut components = context.create_parsing_components(&known);

        if m.get(YEAR_GROUP).is_some_and(|s| !s.is_empty()) {
            if let Some(year) = parse_year(m.get(YEAR_GROUP).unwrap_or("")) {
                components.assign(Component::Year, year);
            }
        } else {
            let year = find_year_closest_to_ref(context.ref_date, day.unwrap_or(0), month);
            components.imply(Component::Year, year);
        }

        if !m.get(DATE_TO_GROUP).is_some_and(|s| !s.is_empty()) {
            return Extracted::Components(components);
        }

        // Text can be 'range' value. Such as 'January 12 - 13, 2012'
        let end_date = parse_ordinal_number_pattern(m.get(DATE_TO_GROUP).unwrap_or(""));
        let mut result = context.create_parsing_result(m.index, m.text(), None, None);
        let mut end = components.js_clone();
        if let Some(d) = end_date {
            end.assign(Component::Day, d);
        }
        result.start = components;
        result.end = Some(end);
        Extracted::Result(result)
    }
}
