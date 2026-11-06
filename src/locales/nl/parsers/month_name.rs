//! upstream `locales/nl/parsers/NLMonthNameParser.ts`.

use std::sync::LazyLock;

use crate::calculation::years::find_year_closest_to_ref;
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::Component;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::pattern::{dict_get, dict_keys, match_any_pattern};
use crate::locales::nl::constants::{parse_year, MONTH_DICTIONARY, YEAR_PATTERN};

pub const UPSTREAM: &str = "NLMonthNameParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(NlMonthNameParser))
}

static PATTERN: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(
        &format!(
            concat!(
                r"({})",
                r"\s*",
                r"(?:",
                r"[,-]?\s*({})?",
                r")?",
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

struct NlMonthNameParser;

impl WordBoundaryParser for NlMonthNameParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        PATTERN.clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let mut components = context.create_parsing_components(&[]);
        components.imply(Component::Day, 1);

        let month_name = m.get(MONTH_NAME_GROUP).unwrap_or("").to_lowercase();
        let month = dict_get(MONTH_DICTIONARY, &month_name).unwrap_or(0);
        components.assign(Component::Month, month);

        if let Some(y) = m.get(YEAR_GROUP).filter(|s| !s.is_empty()) {
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
