//! factory drill D2 (`drills/D2-repair-escalate.md`); no upstream file.

use crate::core::chrono::{Extracted, Parser};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::js_regex;

pub const UPSTREAM: &str = "FactoryDrillRepairEscalate";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(FactoryDrillRepairEscalate)
}

struct FactoryDrillRepairEscalate;

impl Parser for FactoryDrillRepairEscalate {
    fn pattern(&self, _context: &ParsingContext) -> JsRegex {
        js_regex!(r"__factory_drill_d2__", "").clone()
    }

    fn extract(&self, _context: &ParsingContext, _m: &mut RegexMatch) -> Extracted {
        Extracted::None
    }
}
