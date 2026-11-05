//! upstream `locales/id/parsers/IDCasualDateParser.ts`.

use crate::common::casual_references as references;
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::js::is_js_whitespace;
use crate::js_regex;

pub const UPSTREAM: &str = "IDCasualDateParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(IdCasualDateParser))
}

struct IdCasualDateParser;

impl WordBoundaryParser for IdCasualDateParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        js_regex!(
            r"(sekarang|saat\s+ini|hari\s+ini|kemarin\s+lusa|kemarin|besok\s+lusa|besok|lusa|nanti\s+malam|malam\s+ini|tadi\s+malam|semalam)(?=\W|$)",
            "i"
        )
        .clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        // toLowerCase().replace(/\s+/g, " ")
        let mut key = String::new();
        let mut in_ws = false;
        for c in m.get(1).unwrap_or("").to_lowercase().chars() {
            if is_js_whitespace(c) {
                if !in_ws {
                    key.push(' ');
                }
                in_ws = true;
            } else {
                key.push(c);
                in_ws = false;
            }
        }
        let reference = context.reference;
        match key.as_str() {
            "sekarang" | "saat ini" => Extracted::Components(references::now(reference)),
            "hari ini" => Extracted::Components(references::today(reference)),
            "kemarin" => Extracted::Components(references::yesterday(reference)),
            "kemarin lusa" => Extracted::Components(references::the_day_before(reference, 2)),
            "besok" => Extracted::Components(references::tomorrow(reference)),
            "lusa" | "besok lusa" => Extracted::Components(references::the_day_after(reference, 2)),
            "nanti malam" | "malam ini" => Extracted::Components(references::tonight(reference, 22)),
            "tadi malam" | "semalam" => Extracted::Components(references::last_night(reference, 0)),
            _ => Extracted::Components(context.create_parsing_components(&[])),
        }
    }
}
