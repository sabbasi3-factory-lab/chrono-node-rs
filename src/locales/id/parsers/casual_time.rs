//! upstream `locales/id/parsers/IDCasualTimeParser.ts`.

use crate::common::casual_references as references;
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::js::is_js_whitespace;
use crate::js_regex;

pub const UPSTREAM: &str = "IDCasualTimeParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(IdCasualTimeParser))
}

struct IdCasualTimeParser;

impl WordBoundaryParser for IdCasualTimeParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        js_regex!(
            r"(?:(?:pada|di)\s+)?(tengah\s+malam|tengah\s+hari|pagi|siang|sore|petang|malam(?!\s+ini))(?:\s+ini)?(?=\W|$)",
            "i"
        )
        .clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        // replace(/\s+/g, " ")
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
            "pagi" => Extracted::Components(references::morning(reference, 6)),
            "siang" | "tengah hari" => Extracted::Components(references::noon(reference)),
            "sore" | "petang" => Extracted::Components(references::afternoon(reference, 15)),
            "malam" => Extracted::Components(references::evening(reference, 20)),
            "tengah malam" => Extracted::Components(references::midnight(reference)),
            _ => Extracted::None,
        }
    }
}
