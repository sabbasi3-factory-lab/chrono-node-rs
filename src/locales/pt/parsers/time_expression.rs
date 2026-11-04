//! upstream `locales/pt/parsers/PTTimeExpressionParser.ts`.

use crate::common::time_expression::{TimeExpression, TimeExpressionParser};
use crate::core::chrono::Parser;
use crate::core::configuration::Flags;

pub const UPSTREAM: &str = "PTTimeExpressionParser";

pub fn create(flags: &Flags) -> Box<dyn Parser> {
    Box::new(TimeExpression::new(PtTimeExpressionParser { strict_mode: flags.get("strictMode") }))
}

struct PtTimeExpressionParser {
    strict_mode: bool,
}

impl TimeExpressionParser for PtTimeExpressionParser {
    fn strict_mode(&self) -> bool {
        self.strict_mode
    }

    fn primary_prefix(&self) -> &str {
        r"(?:(?:ao?|às?|das|da|de|do)\s*)?"
    }

    fn following_phase(&self) -> &str {
        r"\s*(?:\-|\–|\~|\〜|a(?:o)?|\?)\s*"
    }
}
