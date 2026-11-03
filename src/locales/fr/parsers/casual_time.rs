//! upstream `locales/fr/parsers/FRCasualTimeParser.ts`.

use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::{meridiem, Component};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::js_regex;

pub const UPSTREAM: &str = "FRCasualTimeParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(FrCasualTimeParser))
}

struct FrCasualTimeParser;

impl WordBoundaryParser for FrCasualTimeParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        js_regex!(
            r"(cet?)?\s*(matin|soir|après-midi|aprem|a midi|à minuit)(?=\W|$)",
            "i"
        )
        .clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let suffix_lower = m.get(2).unwrap_or("").to_lowercase();
        let mut component = context.create_parsing_components(&[]);

        match suffix_lower.as_str() {
            "après-midi" | "aprem" => {
                component.imply(Component::Hour, 14);
                component.imply(Component::Minute, 0);
                component.imply(Component::Meridiem, meridiem::PM);
                component.add_tag("casualReference/afternoon");
            }
            "soir" => {
                component.imply(Component::Hour, 18);
                component.imply(Component::Minute, 0);
                component.imply(Component::Meridiem, meridiem::PM);
                component.add_tag("casualReference/evening");
            }
            "matin" => {
                component.imply(Component::Hour, 8);
                component.imply(Component::Minute, 0);
                component.imply(Component::Meridiem, meridiem::AM);
                component.add_tag("casualReference/morning");
            }
            "a midi" => {
                component.imply(Component::Hour, 12);
                component.imply(Component::Minute, 0);
                component.imply(Component::Meridiem, meridiem::AM);
                component.add_tag("casualReference/noon");
            }
            "à minuit" => {
                component.imply(Component::Hour, 0);
                component.imply(Component::Meridiem, meridiem::AM);
                component.add_tag("casualReference/midnight");
            }
            _ => {}
        }

        Extracted::Components(component)
    }
}
