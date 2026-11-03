//! upstream `locales/fr/parsers/FRTimeExpressionParser.ts`.

use crate::common::time_expression::{self, TimeExpression, TimeExpressionParser};
use crate::core::chrono::Parser;
use crate::core::components::ParsingComponents;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::RegexMatch;
use crate::js_regex;

pub const UPSTREAM: &str = "FRTimeExpressionParser";

pub fn create(flags: &Flags) -> Box<dyn Parser> {
    Box::new(TimeExpression::new(FrTimeExpressionParser { strict_mode: flags.get("strictMode") }))
}

struct FrTimeExpressionParser {
    strict_mode: bool,
}

impl TimeExpressionParser for FrTimeExpressionParser {
    fn strict_mode(&self) -> bool {
        self.strict_mode
    }

    fn primary_prefix(&self) -> &str {
        r"(?:(?:[àa])\s*)?"
    }

    fn following_phase(&self) -> &str {
        r"\s*(?:\-|\–|\~|\〜|[àa]|\?)\s*"
    }

    fn extract_primary_time_components(&self, context: &ParsingContext, m: &RegexMatch) -> Option<ParsingComponents> {
        // This looks more like a year e.g. 2020
        if js_regex!(r"^\s*\d{4}\s*$").is_match(m.text()) {
            return None;
        }

        time_expression::extract_primary_time_components(self.strict_mode, context, m)
    }
}
