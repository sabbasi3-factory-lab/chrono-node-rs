//! factory drill D7 (`drills/D7-post-merge.md`); no upstream file.

use crate::core::chrono::{Extracted, Parser};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::js_regex;

pub const UPSTREAM: &str = "FactoryDrillPostMerge";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(FactoryDrillPostMerge)
}

struct FactoryDrillPostMerge;

impl Parser for FactoryDrillPostMerge {
    fn pattern(&self, _context: &ParsingContext) -> JsRegex {
        js_regex!(r"__factory_drill_d7__", "").clone()
    }

    fn extract(&self, _context: &ParsingContext, _m: &mut RegexMatch) -> Extracted {
        Extracted::None
    }
}
