//! factory drill D4 (`drills/D4-reviewer-objects.md`); no upstream file.

use crate::core::chrono::{Extracted, Parser};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::js_regex;

pub const UPSTREAM: &str = "FactoryDrillReviewerObjects";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(FactoryDrillReviewerObjects)
}

struct FactoryDrillReviewerObjects;

impl Parser for FactoryDrillReviewerObjects {
    fn pattern(&self, _context: &ParsingContext) -> JsRegex {
        js_regex!(r"__factory_drill_d4__", "").clone()
    }

    fn extract(&self, _context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let _group = m.get(1).unwrap();
        Extracted::None
    }
}
