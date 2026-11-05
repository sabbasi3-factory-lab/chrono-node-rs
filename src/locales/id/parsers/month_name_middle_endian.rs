//! upstream `locales/id/parsers/IDMonthNameMiddleEndianParser.ts`.

use std::sync::LazyLock;

use crate::calculation::years::find_year_closest_to_ref;
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::Component;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::js::js_parse_int;
use crate::core::utils::pattern::{dict_get, dict_keys, match_any_pattern};
use crate::locales::id::constants::{parse_year, MONTH_DICTIONARY, YEAR_PATTERN};

pub const UPSTREAM: &str = "IDMonthNameMiddleEndianParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(IdMonthNameMiddleEndianParser))
}

static PATTERN: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(
        &format!(
            concat!(
                r"({month})",
                r"(?:-|/|\s*,?\s*)",
                r"([0-9]{{1,2}})",
                r"(?:",
                r"\s*(?:-|–|s\.d\.?|s/d|sampai(?:\s+dengan)?|hingga)\s*",
                r"([0-9]{{1,2}})",
                r")?",
                r"(?:",
                r"(?:-|/|\s*,\s*|\s+)",
                r"(?:tahun\s+)?({year})",
                r")?",
                r"(?=\W|$)(?![.:]\d)",
            ),
            month = match_any_pattern(dict_keys(MONTH_DICTIONARY)),
            year = YEAR_PATTERN
        ),
        "i",
    )
});

const MONTH_NAME_GROUP: usize = 1;
const DATE_GROUP: usize = 2;
const DATE_TO_GROUP: usize = 3;
const YEAR_GROUP: usize = 4;

struct IdMonthNameMiddleEndianParser;

impl WordBoundaryParser for IdMonthNameMiddleEndianParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        PATTERN.clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let month = dict_get(MONTH_DICTIONARY, &m.get(MONTH_NAME_GROUP).unwrap_or("").to_lowercase()).unwrap_or(0);
        let day = js_parse_int(m.get(DATE_GROUP).unwrap_or(""));
        if day.is_some_and(|d| d > 31) {
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

        let end_date = js_parse_int(m.get(DATE_TO_GROUP).unwrap_or(""));
        if end_date.is_some_and(|d| d > 31) {
            return Extracted::None;
        }

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
