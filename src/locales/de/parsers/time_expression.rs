//! upstream `locales/de/parsers/DETimeExpressionParser.ts`.

use crate::common::time_expression::{self, TimeExpression, TimeExpressionParser};
use crate::core::chrono::Parser;
use crate::core::components::ParsingComponents;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::RegexMatch;
use crate::js_regex;

pub const UPSTREAM: &str = "DETimeExpressionParser";

pub fn create(flags: &Flags) -> Box<dyn Parser> {
    Box::new(TimeExpression::new(DeTimeExpressionParser { strict_mode: flags.get("strictMode") }))
}

struct DeTimeExpressionParser {
    strict_mode: bool,
}

impl TimeExpressionParser for DeTimeExpressionParser {
    fn strict_mode(&self) -> bool {
        self.strict_mode
    }

    fn primary_prefix(&self) -> &str {
        r"(?:(?:um|von)\s*)?"
    }

    fn following_phase(&self) -> &str {
        r"\s*(?:\-|\–|\~|\〜|bis)\s*"
    }

    fn extract_primary_time_components(&self, context: &ParsingContext, m: &RegexMatch) -> Option<ParsingComponents> {
        // This looks more like a year e.g. 2020
        if js_regex!(r"^\s*\d{4}\s*$").is_match(m.text()) {
            return None;
        }
        time_expression::extract_primary_time_components(self.strict_mode, context, m)
    }
}
