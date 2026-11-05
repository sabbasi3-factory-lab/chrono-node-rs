//! upstream `locales/id/parsers/IDTimeExpressionParser.ts`.

use crate::common::time_expression::{self, TimeExpression, TimeExpressionParser};
use crate::core::chrono::Parser;
use crate::core::components::{meridiem, Component, ParsingComponents};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::RegexMatch;
use crate::js_regex;

pub const UPSTREAM: &str = "IDTimeExpressionParser";

// Captured by primary_suffix(), after the groups of the base primary pattern
const DAY_PERIOD_GROUP: usize = 7;

pub fn create(flags: &Flags) -> Box<dyn Parser> {
    Box::new(TimeExpression::new(IdTimeExpressionParser { strict_mode: flags.get("strictMode") }))
}

struct IdTimeExpressionParser {
    strict_mode: bool,
}

impl TimeExpressionParser for IdTimeExpressionParser {
    fn strict_mode(&self) -> bool {
        self.strict_mode
    }

    fn primary_prefix(&self) -> &str {
        r"(?:(?:pada\s+)?(?:pukul|pkl\.?|jam)\s*)?"
    }

    fn following_phase(&self) -> &str {
        r"\s*(?:\-|\–|\~|\〜|s\.d\.?|s/d|sampai(?:\s+dengan)?|hingga)\s*(?:(?:pukul|pkl\.?|jam)\s*)?"
    }

    fn primary_suffix(&self) -> &str {
        r"(?:\s*(pagi|siang|sore|petang|malam))?(?!/)(?=\W|$)"
    }

    fn extract_primary_time_components(&self, context: &ParsingContext, m: &RegexMatch) -> Option<ParsingComponents> {
        // This looks more like a year e.g. 2020
        if js_regex!(r"^\s*\d{4}\s*$").is_match(m.text()) {
            return None;
        }

        let mut components = time_expression::extract_primary_time_components(self.strict_mode, context, m)?;
        let period = match m.get(DAY_PERIOD_GROUP) {
            Some(p) if !p.is_empty() => p,
            _ => return Some(components),
        };
        if components.is_certain(Component::Meridiem) {
            return Some(components);
        }

        let mut hour = components.get_or_zero(Component::Hour);
        if hour > 12 {
            return Some(components);
        }

        match period.to_lowercase().as_str() {
            "pagi" => {
                // "jam 12 pagi" is midnight
                if hour == 12 {
                    hour = 0;
                }
            }
            "siang" => {
                // "jam 11 siang" is still before noon, "jam 1 siang" is 13:00
                if hour < 10 {
                    hour += 12;
                }
            }
            "sore" | "petang" => {
                if hour < 12 {
                    hour += 12;
                }
            }
            "malam" => {
                // "jam 12 malam" is midnight, "jam 2 malam" is late at night
                if hour == 12 {
                    hour = 0;
                } else if hour >= 5 {
                    hour += 12;
                }
            }
            _ => {}
        }

        components.assign(Component::Hour, hour);
        components.assign(Component::Meridiem, if hour >= 12 { meridiem::PM } else { meridiem::AM });
        Some(components)
    }
}
