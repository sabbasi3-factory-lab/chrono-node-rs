//! upstream `locales/en/parsers/ENMonthNameMiddleEndianParser.ts`.

use std::sync::LazyLock;

use crate::calculation::years::find_year_closest_to_ref;
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::Component;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::pattern::{dict_get, dict_keys, match_any_pattern};
use crate::locales::en::constants::{
    parse_ordinal_number_pattern, parse_year, MONTH_DICTIONARY, ORDINAL_NUMBER_PATTERN, YEAR_PATTERN,
};

pub const UPSTREAM: &str = "ENMonthNameMiddleEndianParser";

pub fn create(flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(EnMonthNameMiddleEndianParser {
        should_skip_year_like_date: flags.get("shouldSkipYearLikeDate"),
    }))
}

static PATTERN: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(
        &format!(
            concat!(
                r"({month})",
                r"(?:-|/|\s*,?\s*)",
                r"({ord})(?!\s*(?:am|pm))\s*",
                r"(?:",
                r"(?:to|\-)\s*",
                r"({ord})\s*",
                r")?",
                r"(?:",
                r"(?:-|/|\s*,\s*|\s+)",
                r"({year})",
                r")?",
                r"(?=\W|$)(?!\:\d)",
            ),
            month = match_any_pattern(dict_keys(MONTH_DICTIONARY)),
            ord = *ORDINAL_NUMBER_PATTERN,
            year = YEAR_PATTERN
        ),
        "i",
    )
});

const MONTH_NAME_GROUP: usize = 1;
const DATE_GROUP: usize = 2;
const DATE_TO_GROUP: usize = 3;
const YEAR_GROUP: usize = 4;

struct EnMonthNameMiddleEndianParser {
    should_skip_year_like_date: bool,
}

impl WordBoundaryParser for EnMonthNameMiddleEndianParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        PATTERN.clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let month = dict_get(MONTH_DICTIONARY, &m.get(MONTH_NAME_GROUP).unwrap_or("").to_lowercase()).unwrap_or(0);
        let date_text = m.get(DATE_GROUP).unwrap_or("");
        let day = parse_ordinal_number_pattern(date_text);
        if day.is_some_and(|d| d > 31) {
            return Extracted::None;
        }

        let has_to = m.get(DATE_TO_GROUP).is_some_and(|s| !s.is_empty());
        let has_year = m.get(YEAR_GROUP).is_some_and(|s| !s.is_empty());

        // Skip the case where the day looks like a year (ex: January 21)
        if self.should_skip_year_like_date
            && !has_to
            && !has_year
            && date_text.len() == 2
            && date_text.bytes().all(|b| b.is_ascii_digit())
        {
            return Extracted::None;
        }

        let mut known = Vec::new();
        if let Some(d) = day {
            known.push((Component::Day, d));
        }
        known.push((Component::Month, month));
        let mut components = context.create_parsing_components(&known);
        components.add_tag("parser/ENMonthNameMiddleEndianParser");

        if has_year {
            if let Some(year) = parse_year(m.get(YEAR_GROUP).unwrap_or("")) {
                components.assign(Component::Year, year);
            }
        } else {
            let year = find_year_closest_to_ref(context.ref_date, day.unwrap_or(0), month);
            components.imply(Component::Year, year);
        }
        if !has_to {
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

#[cfg(test)]
mod tests {
    use crate::{JsDate, ParsingOption, ReferenceInput};

    /// Escaped defect (held-out comparison, seeds 740634720 and 1029150208): a range's end is an
    /// upstream `clone()` of the start, and upstream's `clone()` drops tags. Expected values are
    /// chrono-node 2.10.3's output (TZ=UTC), including its quirk of an end before the start.
    #[test]
    fn range_end_is_an_upstream_clone_without_tags() {
        let cases = [
            (crate::strict(), "jul first-15 am", "2013-12-31T19:05:33.000Z", "jul first-15", "2014-07-01T12:00:00.000Z", "2014-07-15T12:00:00.000Z"),
            (crate::casual(), "Jan 3rd-9 meeting", "2012-08-10T00:00:00.000Z", "Jan 3rd-9", "2013-01-03T12:00:00.000Z", "2013-01-09T12:00:00.000Z"),
            (crate::casual(), "jul 21st-4", "2038-01-01T00:00:00.000Z", "jul 21st-4", "2037-07-21T12:00:00.000Z", "2037-07-04T12:00:00.000Z"),
        ];
        for (chrono, text, reference, matched, start, end) in cases {
            let reference = ReferenceInput::Date(JsDate::parse_iso(reference).unwrap());
            let results = chrono.parse(text, &reference, &ParsingOption::default());
            assert_eq!(results.len(), 1, "{text}");
            let r = &results[0];
            assert_eq!((r.index, r.text.as_str()), (0, matched), "{text}");
            assert_eq!(r.start.date().to_iso_string().unwrap(), start, "{text}");
            assert_eq!(r.start.tags(), ["parser/ENMonthNameMiddleEndianParser"], "{text}");
            let e = r.end.as_ref().expect("a range");
            assert_eq!(e.date().to_iso_string().unwrap(), end, "{text}");
            assert!(e.tags().is_empty(), "{text}: upstream's end has no tags, got {:?}", e.tags());
        }
    }
}
