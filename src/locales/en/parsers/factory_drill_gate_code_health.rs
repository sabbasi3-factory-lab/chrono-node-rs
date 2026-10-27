//! factory drill D8d (`drills/D8d-gate-code-health.md`); no upstream file.

use crate::core::chrono::{Extracted, Parser};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::js_regex;

pub const UPSTREAM: &str = "FactoryDrillGateCodeHealth";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(FactoryDrillGateCodeHealth)
}

#[derive(Debug, Default)]
pub struct FactoryDrillFlags {
    pub a: bool,
    pub b: bool,
    pub c: bool,
    pub d: bool,
}

struct FactoryDrillGateCodeHealth;

impl Parser for FactoryDrillGateCodeHealth {
    fn pattern(&self, _context: &ParsingContext) -> JsRegex {
        js_regex!(r"__factory_drill_d8d__", "").clone()
    }

    fn extract(&self, _context: &ParsingContext, _m: &mut RegexMatch) -> Extracted {
        Extracted::None
    }
}
