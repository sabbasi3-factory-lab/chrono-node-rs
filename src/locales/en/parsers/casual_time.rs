//! upstream `locales/en/parsers/ENCasualTimeParser.ts`.

use crate::common::casual_references as references;
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::js_regex;

pub const UPSTREAM: &str = "ENCasualTimeParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(EnCasualTimeParser))
}

struct EnCasualTimeParser;

impl WordBoundaryParser for EnCasualTimeParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        js_regex!(
            r"(?:this)?\s{0,3}(morning|afternoon|evening|night|midnight|midday|noon)(?=\W|$)",
            "i"
        )
        .clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let key = m.get(1).unwrap_or("").to_lowercase();
        let mut component = match key.as_str() {
            "afternoon" => references::afternoon(context.reference, 15),
            "evening" | "night" => references::evening(context.reference, 20),
            "midnight" => references::midnight(context.reference),
            "morning" => references::morning(context.reference, 6),
            "noon" | "midday" => references::noon(context.reference),
            _ => return Extracted::None,
        };
        component.add_tag("parser/ENCasualTimeParser");
        Extracted::Components(component)
    }
}
