//! upstream `locales/vi/parsers/VIYearParser.ts`.

use std::sync::LazyLock;

use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::Component;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::locales::vi::constants::{parse_year, YEAR_PATTERN};

pub const UPSTREAM: &str = "VIYearParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(ViYearParser))
}

// năm 1975  |  năm 43 TCN  |  179 TCN (bare BC year without năm prefix)
static PATTERN: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(&format!(r"(?:\bnăm\s*({})|\b([0-9]{{1,4}})\s*(TCN))(?=\W|$)", YEAR_PATTERN), "i")
});

const YEAR_WITH_NAM_GROUP: usize = 1; // năm YYYY or năm YYYY TCN
const BARE_BC_YEAR_GROUP: usize = 2; // bare YYYY in "YYYY TCN"
const BARE_BC_SUFFIX_GROUP: usize = 3; // "TCN" in bare form

struct ViYearParser;

impl WordBoundaryParser for ViYearParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        PATTERN.clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let year_text = match m.get(YEAR_WITH_NAM_GROUP).filter(|s| !s.is_empty()) {
            Some(s) => s.to_string(),
            None => format!(
                "{} {}",
                m.get(BARE_BC_YEAR_GROUP).unwrap_or("undefined"),
                m.get(BARE_BC_SUFFIX_GROUP).unwrap_or("undefined")
            ),
        };
        // Every alternative has digits, so `parseYear` never gives NaN here.
        let Some(year) = parse_year(&year_text) else {
            return Extracted::None;
        };
        let mut result = context.create_parsing_result(m.index, m.text(), None, None);
        result.start.assign(Component::Year, year);
        result.start.imply(Component::Month, 1);
        result.start.imply(Component::Day, 1);
        Extracted::Result(result)
    }
}
