//! upstream `locales/en/parsers/ENEndOfCurrentMonthParser.ts`.

use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::Component;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::js_date::JsDate;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::js_regex;

pub const UPSTREAM: &str = "ENEndOfCurrentMonthParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(EnEndOfCurrentMonthParser))
}

struct EnEndOfCurrentMonthParser;

impl WordBoundaryParser for EnEndOfCurrentMonthParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        js_regex!(r"(?:last\s+day|end)\s+of\s+(?:the\s+)?month(?=\W|$)", "i").clone()
    }

    fn inner_extract(&self, context: &ParsingContext, _m: &mut RegexMatch) -> Extracted {
        let target_date = context.reference.get_date_with_adjusted_timezone();
        let year = target_date.get_full_year();
        let month = target_date.get_month() + 1;
        let last_day = JsDate::local(year, month, 0, 0, 0, 0, 0).get_date();
        let mut components = context.create_parsing_components(&[]);

        components.assign(Component::Day, last_day);
        components.assign(Component::Month, month);
        components.assign(Component::Year, year);
        components.add_tag("parser/ENEndOfCurrentMonthParser");
        Extracted::Components(components)
    }
}
