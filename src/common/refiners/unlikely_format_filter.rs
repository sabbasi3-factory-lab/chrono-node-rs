//! upstream `common/refiners/UnlikelyFormatFilter.ts`.

use crate::common::abstract_refiners::{FilterRefiner, Filtering};
use crate::core::chrono::Refiner;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::result::ParsingResult;
use crate::js_regex;

pub const UPSTREAM: &str = "UnlikelyFormatFilter";

pub fn create(flags: &Flags) -> Box<dyn Refiner> {
    Box::new(Filtering::new(UnlikelyFormatFilter::new(flags.get("strictMode"))))
}

/// upstream `UnlikelyFormatFilter`.
pub struct UnlikelyFormatFilter {
    strict_mode: bool,
}

impl UnlikelyFormatFilter {
    pub fn new(strict_mode: bool) -> UnlikelyFormatFilter {
        UnlikelyFormatFilter { strict_mode }
    }

    fn is_strict_mode_valid(&self, result: &ParsingResult) -> bool {
        !result.start.is_only_weekday_component()
    }
}

impl FilterRefiner for UnlikelyFormatFilter {
    fn is_valid(&self, _context: &ParsingContext, result: &ParsingResult) -> bool {
        // JS `replace(" ", "")` removes only the first space.
        let text = result.text.replacen(' ', "", 1);
        if js_regex!(r"^\d*(\.\d*)?$").is_match(&text) {
            return false;
        }

        if !result.start.is_valid_date() {
            return false;
        }

        if let Some(end) = &result.end {
            if !end.is_valid_date() {
                return false;
            }
        }

        if self.strict_mode {
            return self.is_strict_mode_valid(result);
        }

        true
    }
}
