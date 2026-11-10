//! upstream `locales/it/refiners/ITUnlikelyFormatFilter.ts`.

use crate::common::abstract_refiners::{FilterRefiner, Filtering};
use crate::core::chrono::Refiner;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::result::ParsingResult;
use crate::core::utils::js::js_trim;

pub const UPSTREAM: &str = "ITUnlikelyFormatFilter";

pub fn create(_flags: &Flags) -> Box<dyn Refiner> {
    Box::new(Filtering::new(ItUnlikelyFormatFilter))
}

struct ItUnlikelyFormatFilter;

impl FilterRefiner for ItUnlikelyFormatFilter {
    fn is_valid(&self, context: &ParsingContext, result: &ParsingResult) -> bool {
        let text = js_trim(&result.text);

        // If the result consists of the whole text (e.g. "2024", "Maggio"), it isn't unlikely.
        if text == js_trim(&context.text) {
            return true;
        }

        // In Italian, "secondo" could refer to the ordinal number or timeunit.
        // Upstream returns false here regardless of the text after (quirk kept).
        let lower = text.to_lowercase();
        if lower.ends_with("il secondo") || lower == "secondo" {
            return false;
        }

        true
    }
}
