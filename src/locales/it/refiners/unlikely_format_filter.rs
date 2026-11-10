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

        // A result that is the whole text (e.g. "2024", "Maggio") isn't unlikely.
        if text == js_trim(&context.text) {
            return true;
        }

        // In Italian, "secondo" could refer to the ordinal number or timeunit.
        let lower = text.to_lowercase();
        if lower.ends_with("il secondo") || lower == "secondo" {
            return false;
        }

        true
    }
}

#[cfg(test)]
mod tests {
    //! Expected values come from the contract's cases, recorded from the pinned chrono-node.
    use super::*;
    use crate::core::components::Component;
    use crate::core::context::ParsingOption;
    use crate::core::js_date::JsDate;

    /// Runs the filter alone on one date result; returns the surviving `(index, text)` pairs.
    fn refine(text: &str, index: usize, result_text: &str) -> Vec<(usize, String)> {
        let reference = JsDate::parse_iso("2024-03-06T12:00:00.000Z").unwrap();
        let context = crate::core::context::ParsingContext::new(
            text,
            &reference.into(),
            ParsingOption::default(),
            reference,
        );
        let mut start = context.create_parsing_components(&[(Component::Day, 2)]);
        start.imply(Component::Month, 3);
        let result = context.create_parsing_result(index, result_text, Some(start), None);
        create(&Flags::none())
            .refine(&context, vec![result])
            .into_iter()
            .map(|r| (r.index, r.text))
            .collect()
    }

    #[test]
    fn drops_il_secondo_inside_longer_text() {
        assert!(refine("arrivo il secondo poi", 7, "il secondo").is_empty());
    }

    #[test]
    fn drops_bare_secondo_inside_longer_text() {
        assert!(refine("aspetta secondo me", 8, "secondo").is_empty());
    }

    #[test]
    fn keeps_a_result_that_is_the_whole_text() {
        assert_eq!(refine("il secondo", 0, "il secondo"), [(0, "il secondo".to_string())]);
    }

    #[test]
    fn keeps_other_results() {
        assert_eq!(refine("ci vediamo domani", 11, "domani"), [(11, "domani".to_string())]);
    }
}
