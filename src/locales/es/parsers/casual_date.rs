//! upstream `locales/es/parsers/ESCasualDateParser.ts`.

use crate::common::casual_references as references;
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::js_regex;

pub const UPSTREAM: &str = "ESCasualDateParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(EsCasualDateParser))
}

struct EsCasualDateParser;

impl WordBoundaryParser for EsCasualDateParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        js_regex!(r"(ahora|hoy|mañana|manana|ayer)(?=\W|$)", "i").clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let lower_text = m.text().to_lowercase();
        let component = context.create_parsing_components(&[]);

        if (lower_text == "mañana" || lower_text == "manana")
            && js_regex!(r"(?:^|[^\p{L}\p{N}\p{M}_])(?:a|en)\s+la\s*$", "iu").is_match(&context.text[..m.index])
        {
            return Extracted::None;
        }

        match lower_text.as_str() {
            "ahora" => Extracted::Components(references::now(context.reference)),
            "hoy" => Extracted::Components(references::today(context.reference)),
            "mañana" | "manana" => Extracted::Components(references::tomorrow(context.reference)),
            "ayer" => Extracted::Components(references::yesterday(context.reference)),
            _ => Extracted::Components(component),
        }
    }
}
