//! upstream `common/refiners/ExtractTimezoneOffsetRefiner.ts`.

use crate::core::chrono::Refiner;
use crate::core::components::Component;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::result::ParsingResult;
use crate::js_regex;

pub const UPSTREAM: &str = "ExtractTimezoneOffsetRefiner";

pub fn create(_flags: &Flags) -> Box<dyn Refiner> {
    Box::new(ExtractTimezoneOffsetRefiner)
}

pub struct ExtractTimezoneOffsetRefiner;

impl Refiner for ExtractTimezoneOffsetRefiner {
    fn refine(&self, context: &ParsingContext, mut results: Vec<ParsingResult>) -> Vec<ParsingResult> {
        for result in results.iter_mut() {
            if result.start.is_certain(Component::TimezoneOffset) {
                continue;
            }

            let suffix = &context.text[result.index + result.text.len()..];
            let Some(m) = js_regex!(
                r"^\s*(?:\(?(?:GMT|UTC)\s?)?([+-])(\d{1,2})(?::?(\d{2}))?\)?",
                "i"
            )
            .exec(suffix) else {
                continue;
            };

            let hour_offset: i64 = m.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);
            let minute_offset: i64 = m
                .get(3)
                .filter(|s| !s.is_empty())
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
            let mut timezone_offset = hour_offset * 60 + minute_offset;
            // No timezones have offsets greater than 14 hours, so disregard this match
            if timezone_offset > 14 * 60 {
                continue;
            }
            if m.get(1) == Some("-") {
                timezone_offset = -timezone_offset;
            }

            let match_text = m.text().to_string();
            if let Some(end) = result.end.as_mut() {
                end.assign(Component::TimezoneOffset, timezone_offset);
            }

            result.start.assign(Component::TimezoneOffset, timezone_offset);
            result.text.push_str(&match_text);
        }

        results
    }
}
