//! upstream `locales/pt/parsers/PTCasualDateParser.ts`.

use crate::common::casual_references as references;
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::js_regex;

pub const UPSTREAM: &str = "PTCasualDateParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(PtCasualDateParser))
}

struct PtCasualDateParser;

impl WordBoundaryParser for PtCasualDateParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        js_regex!(r"(agora|hoje|amanha|amanhã|ontem)(?=\W|$)", "i").clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let component = match m.text().to_lowercase().as_str() {
            "agora" => references::now(context.reference),
            "hoje" => references::today(context.reference),
            "amanha" | "amanhã" => references::tomorrow(context.reference),
            "ontem" => references::yesterday(context.reference),
            _ => context.create_parsing_components(&[]),
        };
        Extracted::Components(component)
    }
}
