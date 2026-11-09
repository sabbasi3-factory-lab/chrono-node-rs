//! upstream `locales/vi/parsers/VICasualDateParser.ts`.

use crate::common::casual_references as references;
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::js_regex;

pub const UPSTREAM: &str = "VICasualDateParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(ViCasualDateParser))
}

struct ViCasualDateParser;

impl WordBoundaryParser for ViCasualDateParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        js_regex!(r"\b(hôm nay|hôm qua|hôm kia|ngày mai|ngày kia|bây giờ|lúc này)(?=\W|$)", "i").clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let reference = context.reference;
        let component = match m.get(1).unwrap_or("").to_lowercase().as_str() {
            "bây giờ" | "lúc này" => references::now(reference),
            "hôm nay" => references::today(reference),
            "hôm qua" => references::yesterday(reference),
            "hôm kia" => references::the_day_before(reference, 2),
            "ngày mai" => references::tomorrow(reference),
            "ngày kia" => references::the_day_after(reference, 2),
            _ => context.create_parsing_components(&[]),
        };
        Extracted::Components(component)
    }
}
