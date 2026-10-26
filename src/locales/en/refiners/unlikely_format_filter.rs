//! upstream `locales/en/refiners/ENUnlikelyFormatFilter.ts`.

use crate::common::abstract_refiners::{FilterRefiner, Filtering};
use crate::core::chrono::Refiner;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::result::ParsingResult;
use crate::core::utils::js::js_trim;
use crate::js_regex;

pub const UPSTREAM: &str = "ENUnlikelyFormatFilter";

pub fn create(_flags: &Flags) -> Box<dyn Refiner> {
    Box::new(Filtering::new(EnUnlikelyFormatFilter))
}

struct EnUnlikelyFormatFilter;

impl FilterRefiner for EnUnlikelyFormatFilter {
    fn is_valid(&self, context: &ParsingContext, result: &ParsingResult) -> bool {
        let text = js_trim(&result.text);

        if text == js_trim(&context.text) {
            return true;
        }

        let lower = text.to_lowercase();
        if lower == "may" {
            let text_before = js_trim(&context.text[..result.index]);
            if !js_regex!(r"\b(in)$", "i").is_match(text_before) {
                return false;
            }
        }

        // Upstream returns false here regardless of the text after (quirk kept).
        if lower.ends_with("the second") {
            return false;
        }

        true
    }
}
