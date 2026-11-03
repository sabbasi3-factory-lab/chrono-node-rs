//! upstream `locales/fr/parsers/FRCasualDateParser.ts`.

use crate::common::casual_references as references;
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::{meridiem, Component};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::dates::assign_similar_date;
use crate::js_regex;

pub const UPSTREAM: &str = "FRCasualDateParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(FrCasualDateParser))
}

struct FrCasualDateParser;

impl WordBoundaryParser for FrCasualDateParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        js_regex!(r"(maintenant|aujourd'hui|demain|hier|cette\s*nuit|la\s*veille)(?=\W|$)", "i").clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let target_date = context.ref_date;
        let lower_text = m.text().to_lowercase();
        let mut component = context.create_parsing_components(&[]);

        match lower_text.as_str() {
            "maintenant" => return Extracted::Components(references::now(context.reference)),
            "aujourd'hui" => return Extracted::Components(references::today(context.reference)),
            "hier" => return Extracted::Components(references::yesterday(context.reference)),
            "demain" => return Extracted::Components(references::tomorrow(context.reference)),
            _ => {
                if js_regex!(r"cette\s*nuit").is_match(&lower_text) {
                    assign_similar_date(&mut component, target_date);
                    component.imply(Component::Hour, 22);
                    component.imply(Component::Meridiem, meridiem::PM);
                } else if js_regex!(r"la\s*veille").is_match(&lower_text) {
                    let mut previous_day = target_date;
                    previous_day.set_date(previous_day.get_date() - 1);
                    assign_similar_date(&mut component, previous_day);
                    component.imply(Component::Hour, 0);
                }
            }
        }
        Extracted::Components(component)
    }
}
