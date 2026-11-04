//! upstream `locales/pt/parsers/PTMonthNameLittleEndianParser.ts`.

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
use crate::locales::pt::constants::{parse_year, MONTH_DICTIONARY, YEAR_PATTERN};

pub const UPSTREAM: &str = "PTMonthNameLittleEndianParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(PtMonthNameLittleEndianParser))
}

static PATTERN: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(
        &format!(
            concat!(
                r"([0-9]{{1,2}})(?:º|ª|°)?",
                r"(?:\s*(?:desde|de|\-|\–|ao?|\s)\s*([0-9]{{1,2}})(?:º|ª|°)?)?\s*(?:de)?\s*",
                r"(?:-|/|\s*(?:de|,)?\s*)",
                r"({month})",
                r"(?:\s*(?:de|,)?\s*({year}))?",
                r"(?=\W|$)",
            ),
            month = match_any_pattern(dict_keys(MONTH_DICTIONARY)),
            year = YEAR_PATTERN
        ),
        "i",
    )
});

const DATE_GROUP: usize = 1;
const DATE_TO_GROUP: usize = 2;
const MONTH_NAME_GROUP: usize = 3;
const YEAR_GROUP: usize = 4;

struct PtMonthNameLittleEndianParser;

impl WordBoundaryParser for PtMonthNameLittleEndianParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        PATTERN.clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let mut result = context.create_parsing_result(m.index, m.text(), None, None);

        let month = dict_get(MONTH_DICTIONARY, &m.get(MONTH_NAME_GROUP).unwrap_or("").to_lowercase()).unwrap_or(0);
        let day = js_parse_int(m.get(DATE_GROUP).unwrap_or(""));
        if day.is_some_and(|d| d > 31) {
            // e.g. "[96 Aug]" => "9[6 Aug]", we need to shift away from the next number
            m.index += m.get(DATE_GROUP).unwrap_or("").len();
            return Extracted::None;
        }

        result.start.assign(Component::Month, month);
        if let Some(d) = day {
            result.start.assign(Component::Day, d);
        }

        if let Some(y) = m.get(YEAR_GROUP).filter(|s| !s.is_empty()) {
            if let Some(year) = parse_year(y) {
                result.start.assign(Component::Year, year);
            }
        } else {
            let year = find_year_closest_to_ref(context.ref_date, day.unwrap_or(0), month);
            result.start.imply(Component::Year, year);
        }

        if let Some(to) = m.get(DATE_TO_GROUP).filter(|s| !s.is_empty()) {
            let mut end = result.start.js_clone();
            if let Some(d) = js_parse_int(to) {
                end.assign(Component::Day, d);
            }
            result.end = Some(end);
        }

        Extracted::Result(result)
    }
}
