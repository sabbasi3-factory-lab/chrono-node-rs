//! upstream `locales/es/parsers/ESTimeExpressionParser.ts`.

use crate::common::time_expression::{TimeExpression, TimeExpressionParser};
use crate::core::chrono::Parser;
use crate::core::configuration::Flags;

pub const UPSTREAM: &str = "ESTimeExpressionParser";

pub fn create(flags: &Flags) -> Box<dyn Parser> {
    Box::new(TimeExpression::new(EsTimeExpressionParser { strict_mode: flags.get("strictMode") }))
}

struct EsTimeExpressionParser {
    strict_mode: bool,
}

impl TimeExpressionParser for EsTimeExpressionParser {
    fn strict_mode(&self) -> bool {
        self.strict_mode
    }

    fn primary_prefix(&self) -> &str {
        r"(?:(?:aslas|deslas|las?|al?|de|del)\s*)?"
    }

    fn following_phase(&self) -> &str {
        r"\s*(?:\-|\–|\~|\〜|a(?:l)?|\?)\s*"
    }
}
