//! upstream `common/refiners/ExtractTimezoneAbbrRefiner.ts`.

use crate::core::chrono::Refiner;
use crate::core::components::Component;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::result::ParsingResult;
use crate::core::timezone::{to_timezone_offset, TimezoneInput};
use crate::js_regex;

pub const UPSTREAM: &str = "ExtractTimezoneAbbrRefiner";

pub fn create(_flags: &Flags) -> Box<dyn Refiner> {
    Box::new(ExtractTimezoneAbbrRefiner)
}

struct ExtractTimezoneAbbrRefiner;

impl Refiner for ExtractTimezoneAbbrRefiner {
    fn refine(&self, context: &ParsingContext, mut results: Vec<ParsingResult>) -> Vec<ParsingResult> {
        for result in results.iter_mut() {
            let suffix = &context.text[result.index + result.text.len()..];
            let Some(m) = js_regex!(r"^\s*,?\s*\(?([A-Z]{2,4})\)?(?=\W|$)", "i").exec(suffix) else {
                continue;
            };
            let matched_abbr = m.get(1).unwrap_or("").to_string();
            let matched_text = m.text().to_string();

            let timezone_abbr = matched_abbr.to_uppercase();
            let ref_date = result.start.date();
            let Some(extracted) = to_timezone_offset(
                Some(&TimezoneInput::Abbr(timezone_abbr.clone())),
                Some(ref_date),
                &context.option.timezones,
            ) else {
                continue;
            };

            if let Some(current) = result.start.get(Component::TimezoneOffset) {
                if extracted != current {
                    if result.start.is_certain(Component::TimezoneOffset) {
                        continue;
                    }
                    if timezone_abbr != matched_abbr {
                        continue;
                    }
                }
            }

            if result.start.is_only_date() && timezone_abbr != matched_abbr {
                continue;
            }

            result.text.push_str(&matched_text);

            if !result.start.is_certain(Component::TimezoneOffset) {
                result.start.assign(Component::TimezoneOffset, extracted);
            }
            if let Some(end) = result.end.as_mut() {
                if !end.is_certain(Component::TimezoneOffset) {
                    end.assign(Component::TimezoneOffset, extracted);
                }
            }
        }
        results
    }
}
