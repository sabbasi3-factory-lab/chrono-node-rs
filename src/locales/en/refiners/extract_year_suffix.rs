//! upstream `locales/en/refiners/ENExtractYearSuffixRefiner.ts`.

use crate::core::chrono::Refiner;
use crate::core::components::Component;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::JsRegex;
use crate::core::result::ParsingResult;
use crate::core::utils::js::js_trim;
use crate::core::utils::pattern::js_len;
use crate::locales::en::constants::{parse_year, YEAR_PATTERN};

pub const UPSTREAM: &str = "ENExtractYearSuffixRefiner";

pub fn create(_flags: &Flags) -> Box<dyn Refiner> {
    Box::new(EnExtractYearSuffixRefiner {
        year_suffix_pattern: JsRegex::new(&format!(r"^\s*({YEAR_PATTERN})"), "i"),
    })
}

struct EnExtractYearSuffixRefiner {
    year_suffix_pattern: JsRegex,
}

impl Refiner for EnExtractYearSuffixRefiner {
    fn refine(&self, context: &ParsingContext, mut results: Vec<ParsingResult>) -> Vec<ParsingResult> {
        for result in results.iter_mut() {
            if !result.start.is_date_with_unknown_year() {
                continue;
            }
            let suffix = &context.text[result.index + result.text.len()..];
            let Some(m) = self.year_suffix_pattern.exec(suffix) else {
                continue;
            };
            let whole = m.text();
            // A short number, e.g. "14/4 90", isn't assumed to be a year.
            if js_len(js_trim(whole)) <= 3 {
                continue;
            }
            if let Some(year) = m.get(1).and_then(parse_year) {
                if let Some(end) = result.end.as_mut() {
                    end.assign(Component::Year, year);
                }
                result.start.assign(Component::Year, year);
            }
            result.text.push_str(whole);
        }
        results
    }
}
