//! upstream `locales/it/parsers/ITCasualTimeParser.ts`.

use crate::common::casual_references as references;
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::js_regex;

pub const UPSTREAM: &str = "ITCasualTimeParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(ItCasualTimeParser))
}

struct ItCasualTimeParser;

impl WordBoundaryParser for ItCasualTimeParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        js_regex!(
            r"(stamattina|stasera|stanotte|stamani)|(questa\s*)?(mattina|pomeriggio|sera|notte|mezzanotte|mezzogiorno)(?=\W|$)",
            "i"
        )
        .clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let mut component = None;

        // Handle compound words like "stamattina", "stasera", etc.
        if let Some(g1) = m.get(1).filter(|s| !s.is_empty()) {
            match g1.to_lowercase().as_str() {
                "stamattina" | "stamani" => component = Some(references::morning(context.reference, 6)),
                "stasera" | "stanotte" => component = Some(references::evening(context.reference, 20)),
                _ => {}
            }
        } else if let Some(g3) = m.get(3).filter(|s| !s.is_empty()) {
            match g3.to_lowercase().as_str() {
                "pomeriggio" => component = Some(references::afternoon(context.reference, 15)),
                "sera" | "notte" => component = Some(references::evening(context.reference, 20)),
                "mezzanotte" => component = Some(references::midnight(context.reference)),
                "mattina" => component = Some(references::morning(context.reference, 6)),
                "mezzogiorno" => component = Some(references::noon(context.reference)),
                _ => {}
            }
        }
        match component {
            Some(mut c) => {
                c.add_tag("parser/ITCasualTimeParser");
                Extracted::Components(c)
            }
            None => Extracted::None,
        }
    }
}
