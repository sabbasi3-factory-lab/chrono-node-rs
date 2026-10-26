//! factory drill D1 (`drills/D1-repair-ok.md`); no upstream file.

use crate::core::chrono::{Extracted, Parser};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::js_regex;

pub const UPSTREAM: &str = "FactoryDrillRepairOk";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(FactoryDrillRepairOk)
}

struct FactoryDrillRepairOk;

impl Parser for FactoryDrillRepairOk {
    fn pattern(&self, _context: &ParsingContext) -> JsRegex {
        js_regex!(r"__factory_drill_d1__", "").clone()
    }

    fn extract(&self, _context: &ParsingContext, _m: &mut RegexMatch) -> Extracted {
        Extracted::None
    }
}
