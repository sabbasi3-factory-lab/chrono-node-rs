//! upstream `locales/uk/parsers/UKTimeExpressionParser.ts`.

use crate::common::time_expression::{self, TimeExpression, TimeExpressionParser};
use crate::core::chrono::Parser;
use crate::core::components::{meridiem, Component, ParsingComponents};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::RegexMatch;
use crate::locales::uk::constants::{FLAGS, RIGHT_BOUNDARY};

pub const UPSTREAM: &str = "UKTimeExpressionParser";

pub fn create(flags: &Flags) -> Box<dyn Parser> {
    Box::new(TimeExpression::new(UkTimeExpressionParser {
        strict_mode: flags.get("strictMode"),
        primary_suffix: format!(r"(?:\s*(?:ранку|вечора|по обіді|після обіду))?(?!/){RIGHT_BOUNDARY}"),
    }))
}

struct UkTimeExpressionParser {
    strict_mode: bool,
    primary_suffix: String,
}

impl TimeExpressionParser for UkTimeExpressionParser {
    fn strict_mode(&self) -> bool {
        self.strict_mode
    }

    fn pattern_flags(&self) -> &str {
        FLAGS
    }

    fn primary_pattern_left_boundary(&self) -> &str {
        r"(^|\s|T|(?:[^\p{L}\p{N}_]))"
    }

    fn following_phase(&self) -> &str {
        r"\s*(?:\-|\–|\~|\〜|до|і|по|\?)\s*"
    }

    fn primary_prefix(&self) -> &str {
        r"(?:(?:в|у|о|об|з|із|від)\s*)??"
    }

    fn primary_suffix(&self) -> &str {
        &self.primary_suffix
    }

    fn extract_primary_time_components(&self, context: &ParsingContext, m: &RegexMatch) -> Option<ParsingComponents> {
        let mut components = time_expression::extract_primary_time_components(self.strict_mode, context, m)?;
        let text = m.text();

        if text.ends_with("вечора") {
            let hour = components.get_or_zero(Component::Hour);
            if (6..12).contains(&hour) {
                components.assign(Component::Hour, hour + 12);
                components.assign(Component::Meridiem, meridiem::PM);
            } else if hour < 6 {
                components.assign(Component::Meridiem, meridiem::AM);
            }
        }

        if text.ends_with("по обіді") || text.ends_with("після обіду") {
            components.assign(Component::Meridiem, meridiem::PM);
            let hour = components.get_or_zero(Component::Hour);
            if (0..=6).contains(&hour) {
                components.assign(Component::Hour, hour + 12);
            }
        }

        if text.ends_with("ранку") {
            components.assign(Component::Meridiem, meridiem::AM);
            let hour = components.get_or_zero(Component::Hour);
            if hour < 12 {
                components.assign(Component::Hour, hour);
            }
        }

        Some(components)
    }
}
