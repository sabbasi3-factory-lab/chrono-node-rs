//! upstream `locales/en/parsers/ENTimeExpressionParser.ts`.

use crate::common::time_expression::{self, TimeExpression, TimeExpressionParser};
use crate::core::chrono::Parser;
use crate::core::components::{meridiem, Component, ParsingComponents};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::RegexMatch;
use crate::core::result::ParsingResult;

pub const UPSTREAM: &str = "ENTimeExpressionParser";

pub fn create(flags: &Flags) -> Box<dyn Parser> {
    Box::new(TimeExpression::new(EnTimeExpressionParser { strict_mode: flags.get("strictMode") }))
}

struct EnTimeExpressionParser {
    strict_mode: bool,
}

impl TimeExpressionParser for EnTimeExpressionParser {
    fn strict_mode(&self) -> bool {
        self.strict_mode
    }

    fn following_phase(&self) -> &str {
        r"\s*(?:\-|\–|\~|\〜|to|until|through|till|\?)\s*"
    }

    fn primary_prefix(&self) -> &str {
        r"(?:(?:at|from)\s*)??"
    }

    fn primary_suffix(&self) -> &str {
        r"(?:\s*(?:o\W*clock|at\s*night|in\s*the\s*(?:morning|afternoon)))?(?!/)(?=\W|$)"
    }

    fn extract_primary_time_components(&self, context: &ParsingContext, m: &RegexMatch) -> Option<ParsingComponents> {
        let mut components = time_expression::extract_primary_time_components(self.strict_mode, context, m)?;
        let text = m.text();

        if text.ends_with("night") {
            let hour = components.get_or_zero(Component::Hour);
            if (6..12).contains(&hour) {
                components.assign(Component::Hour, hour + 12);
                components.assign(Component::Meridiem, meridiem::PM);
            } else if hour < 6 {
                components.assign(Component::Meridiem, meridiem::AM);
            }
        }

        if text.ends_with("afternoon") {
            components.assign(Component::Meridiem, meridiem::PM);
            let hour = components.get_or_zero(Component::Hour);
            if (0..=6).contains(&hour) {
                components.assign(Component::Hour, hour + 12);
            }
        }

        if text.ends_with("morning") {
            components.assign(Component::Meridiem, meridiem::AM);
            let hour = components.get_or_zero(Component::Hour);
            if hour < 12 {
                components.assign(Component::Hour, hour);
            }
        }

        components.add_tag("parser/ENTimeExpressionParser");
        Some(components)
    }

    fn extract_following_time_components(
        &self,
        context: &ParsingContext,
        m: &RegexMatch,
        result: &mut ParsingResult,
    ) -> Option<ParsingComponents> {
        let mut following = time_expression::extract_following_time_components(context, m, result)?;
        following.add_tag("parser/ENTimeExpressionParser");
        Some(following)
    }
}
