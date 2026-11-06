//! upstream `locales/nl/parsers/NLCasualDateParser.ts`.

use crate::common::casual_references as references;
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::js_regex;

pub const UPSTREAM: &str = "NLCasualDateParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(NlCasualDateParser))
}

struct NlCasualDateParser;

impl WordBoundaryParser for NlCasualDateParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        js_regex!(r"(nu|vandaag|morgen|morgend|gisteren)(?=\W|$)", "i").clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let lower_text = m.text().to_lowercase();
        let component = context.create_parsing_components(&[]);

        match lower_text.as_str() {
            "nu" => Extracted::Components(references::now(context.reference)),
            "vandaag" => Extracted::Components(references::today(context.reference)),
            "morgen" | "morgend" => Extracted::Components(references::tomorrow(context.reference)),
            "gisteren" => Extracted::Components(references::yesterday(context.reference)),
            _ => Extracted::Components(component),
        }
    }
}
