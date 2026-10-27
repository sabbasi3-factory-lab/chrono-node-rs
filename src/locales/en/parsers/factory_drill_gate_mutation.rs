//! factory drill D8b (`drills/D8b-gate-mutation.md`); no upstream file.

use crate::core::chrono::{Extracted, Parser};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::js_regex;

pub const UPSTREAM: &str = "FactoryDrillGateMutation";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(FactoryDrillGateMutation)
}

pub fn drill_score(n: u32) -> u32 {
    if n > 10 {
        n * 2
    } else {
        n + 1
    }
}

struct FactoryDrillGateMutation;

impl Parser for FactoryDrillGateMutation {
    fn pattern(&self, _context: &ParsingContext) -> JsRegex {
        js_regex!(r"__factory_drill_d8b__", "").clone()
    }

    fn extract(&self, _context: &ParsingContext, _m: &mut RegexMatch) -> Extracted {
        Extracted::None
    }
}
