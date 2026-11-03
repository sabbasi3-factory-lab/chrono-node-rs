//! upstream `locales/de/parsers/DECasualTimeParser.ts`.

use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::dates::imply_similar_time;
use crate::js_regex;
use crate::locales::de::casual_time_components::extract_time_components;

pub const UPSTREAM: &str = "DECasualTimeParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(DeCasualTimeParser))
}

struct DeCasualTimeParser;

impl WordBoundaryParser for DeCasualTimeParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        js_regex!(
            r"(diesen)?\s*(morgen|vormittag|mittags?|nachmittag|abend|nacht|mitternacht)(?=\W|$)",
            "i"
        )
        .clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let keyword = m.get(2).unwrap_or("").to_lowercase();
        let mut component = context.create_parsing_components(&[]);
        imply_similar_time(&mut component, context.ref_date);
        extract_time_components(&mut component, &keyword);
        Extracted::Components(component)
    }
}
