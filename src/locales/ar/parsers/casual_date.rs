//! upstream `locales/ar/parsers/ARCasualDateParser.ts`.

use crate::common::casual_references as references;
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::js_regex;
use crate::locales::ar::abstract_parser_with_word_boundary_checking::{
    left_right_boundary_inner_pattern, pattern_left_boundary,
};

pub const UPSTREAM: &str = "ARCasualDateParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(ArCasualDateParser))
}

struct ArCasualDateParser;

impl WordBoundaryParser for ArCasualDateParser {
    fn pattern_left_boundary(&self) -> &str {
        pattern_left_boundary()
    }

    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        left_right_boundary_inner_pattern(
            r"(الآن|الان|حالياً|حاليا|اليوم|أول\s*(?:من\s*)?أمس|اول\s*(?:من\s*)?امس|أول\s*(?:من\s*)?البارحة|اول\s*(?:من\s*)?البارحة|قبل\s*(?:من\s*)?أمس|قبل\s*(?:من\s*)?امس|أمس|امس|البارحة|بعد\s*غد(?:اً|ا)?|بعد\s*بكر[ةا]|غداً|غدا|بكر[ةا])",
        )
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let lower_text = m.get(1).unwrap_or("").to_lowercase();
        let t = lower_text.as_str();
        let reference = context.reference;

        if matches!(t, "الآن" | "الان" | "حالياً" | "حاليا") {
            return Extracted::Components(references::now(reference));
        }

        if t == "اليوم" {
            return Extracted::Components(references::today(reference));
        }

        if js_regex!(r"أول\s*(?:من\s*)?أمس").is_match(t)
            || js_regex!(r"اول\s*(?:من\s*)?امس").is_match(t)
            || js_regex!(r"أول\s*(?:من\s*)?البارحة").is_match(t)
            || js_regex!(r"اول\s*(?:من\s*)?البارحة").is_match(t)
            || js_regex!(r"قبل\s*(?:من\s*)?أمس").is_match(t)
            || js_regex!(r"قبل\s*(?:من\s*)?امس").is_match(t)
        {
            return Extracted::Components(references::the_day_before(reference, 2));
        }

        if matches!(t, "أمس" | "امس" | "البارحة") {
            return Extracted::Components(references::yesterday(reference));
        }

        if js_regex!(r"بعد\s*غد").is_match(t) || js_regex!(r"بعد\s*بكر").is_match(t) {
            return Extracted::Components(references::the_day_after(reference, 2));
        }

        if matches!(t, "غداً" | "غدا") || js_regex!(r"^بكر[ةا]$").is_match(t) {
            return Extracted::Components(references::tomorrow(reference));
        }

        Extracted::Components(context.create_parsing_components(&[]))
    }
}
