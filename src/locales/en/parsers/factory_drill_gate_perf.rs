//! factory drill D8c (`drills/D8c-gate-perf.md`); no upstream file.

use crate::core::chrono::{Extracted, Parser};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::js_regex;

pub const UPSTREAM: &str = "FactoryDrillGatePerf";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(FactoryDrillGatePerf)
}

struct FactoryDrillGatePerf;

impl Parser for FactoryDrillGatePerf {
    fn pattern(&self, _context: &ParsingContext) -> JsRegex {
        js_regex!(r"__factory_drill_d8c__", "").clone()
    }

    fn extract(&self, _context: &ParsingContext, _m: &mut RegexMatch) -> Extracted {
        Extracted::None
    }
}
