//! upstream `locales/en/parsers/ENSlashMonthFormatParser.ts`.

use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::Component;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::js::js_parse_int;
use crate::js_regex;

pub const UPSTREAM: &str = "ENSlashMonthFormatParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(EnSlashMonthFormatParser))
}

const MONTH_GROUP: usize = 1;
const YEAR_GROUP: usize = 2;

struct EnSlashMonthFormatParser;

impl WordBoundaryParser for EnSlashMonthFormatParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        js_regex!(r"([0-9]|0[1-9]|1[012])/([0-9]{4})", "i").clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        // Do not extract a month/year suffix from an invalid numeric date (e.g. "50/6/2018").
        // Parsing can also resume within a rejected match, so check the original text.
        if js_regex!(r"\d/?$").is_match(&context.text[..m.index]) {
            return Extracted::None;
        }

        let year = js_parse_int(m.get(YEAR_GROUP).unwrap_or(""));
        let month = js_parse_int(m.get(MONTH_GROUP).unwrap_or(""));
        let (Some(year), Some(month)) = (year, month) else {
            return Extracted::None;
        };

        let mut components = context.create_parsing_components(&[]);
        components.imply(Component::Day, 1).assign(Component::Month, month).assign(Component::Year, year);
        Extracted::Components(components)
    }
}
