//! upstream `locales/id/parsers/IDMonthNameParser.ts`.

use std::sync::LazyLock;

use crate::calculation::years::find_year_closest_to_ref;
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::Component;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::pattern::{dict_get, dict_keys, js_len, match_any_pattern};
use crate::locales::id::constants::{parse_year, MONTH_DICTIONARY, YEAR_PATTERN};

pub const UPSTREAM: &str = "IDMonthNameParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(IdMonthNameParser))
}

static PATTERN: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(
        &format!(
            concat!(
                r"(?:(?:pada\s+)?bulan\s+)?",
                r"({})",
                r"(?:\s*[,-]?\s*(?:tahun\s+)?({}))?",
                r"(?=[^\s\w]|\s+[^0-9]|\s+$|$)",
            ),
            match_any_pattern(dict_keys(MONTH_DICTIONARY)),
            YEAR_PATTERN
        ),
        "i",
    )
});

const MONTH_NAME_GROUP: usize = 1;
const YEAR_GROUP: usize = 2;

struct IdMonthNameParser;

impl WordBoundaryParser for IdMonthNameParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        PATTERN.clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let month_name = m.get(MONTH_NAME_GROUP).unwrap_or("").to_lowercase();
        let year = m.get(YEAR_GROUP).filter(|s| !s.is_empty());

        // Short abbreviations are too ambiguous to be taken as a month on their own
        if js_len(&month_name) <= 3 && month_name != "mei" && year.is_none() {
            return Extracted::None;
        }

        let mut components = context.create_parsing_components(&[]);
        let month = dict_get(MONTH_DICTIONARY, &month_name).unwrap_or(0);
        components.imply(Component::Day, 1);
        components.assign(Component::Month, month);

        if let Some(y) = year {
            if let Some(year) = parse_year(y) {
                components.assign(Component::Year, year);
            }
        } else {
            let year = find_year_closest_to_ref(context.ref_date, 1, month);
            components.imply(Component::Year, year);
        }

        Extracted::Components(components)
    }
}
