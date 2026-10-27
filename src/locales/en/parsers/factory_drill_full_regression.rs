//! factory drill D5 (`drills/D5-full-regression.md`); no upstream file.

use crate::core::chrono::{Extracted, Parser};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::js_regex;

pub const UPSTREAM: &str = "FactoryDrillFullRegression";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(FactoryDrillFullRegression)
}

struct FactoryDrillFullRegression;

impl Parser for FactoryDrillFullRegression {
    fn pattern(&self, _context: &ParsingContext) -> JsRegex {
        js_regex!(r"__factory_drill_d5__", "").clone()
    }

    fn extract(&self, _context: &ParsingContext, _m: &mut RegexMatch) -> Extracted {
        Extracted::None
    }
}
