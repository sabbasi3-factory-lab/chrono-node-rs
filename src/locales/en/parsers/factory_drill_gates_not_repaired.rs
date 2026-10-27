//! Factory drill D3 (no upstream file).

use crate::core::chrono::{Extracted, Parser};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::js_regex;

pub const UPSTREAM: &str = "FactoryDrillGatesNotRepaired";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(FactoryDrillGatesNotRepaired)
}

struct FactoryDrillGatesNotRepaired;

impl Parser for FactoryDrillGatesNotRepaired {
    fn pattern(&self, _context: &ParsingContext) -> JsRegex {
        js_regex!(r"__factory_drill_d3__", "").clone()
    }

    fn extract(&self, _context: &ParsingContext, _m: &mut RegexMatch) -> Extracted {
        Extracted::None
    }
}
