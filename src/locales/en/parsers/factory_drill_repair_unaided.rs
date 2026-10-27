//! factory drill D1b (`drills/D1b-repair-unaided.md`); no upstream file.
// drill: repaired after 3d8bfef00347794a91de356a653d1ff516dcd610

use crate::core::chrono::{Extracted, Parser};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::js_regex;

pub const UPSTREAM: &str = "FactoryDrillRepairUnaided";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(FactoryDrillRepairUnaided)
}

struct FactoryDrillRepairUnaided;

impl Parser for FactoryDrillRepairUnaided {
    fn pattern(&self, _context: &ParsingContext) -> JsRegex {
        js_regex!(r"__factory_drill_d1b__", "").clone()
    }

    fn extract(&self, _context: &ParsingContext, _m: &mut RegexMatch) -> Extracted {
        Extracted::None
    }
}
