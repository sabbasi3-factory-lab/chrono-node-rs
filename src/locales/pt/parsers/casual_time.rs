//! upstream `locales/pt/parsers/PTCasualTimeParser.ts`.

use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::{meridiem, Component};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::dates::{assign_similar_date, imply_similar_time};
use crate::js_regex;

pub const UPSTREAM: &str = "PTCasualTimeParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(PtCasualTimeParser))
}

struct PtCasualTimeParser;

impl WordBoundaryParser for PtCasualTimeParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        js_regex!(
            r"(?:esta\s*)?(manha|manhã|tarde|meia-noite|meio-dia|noite)(?=\W|$)",
            "i"
        )
        .clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let target_date = context.ref_date;
        let mut component = context.create_parsing_components(&[]);
        match m.get(1).unwrap_or("").to_lowercase().as_str() {
            "tarde" => {
                component.imply(Component::Meridiem, meridiem::PM);
                component.imply(Component::Hour, 15);
                component.add_tag("casualReference/afternoon");
            }
            "noite" => {
                component.imply(Component::Meridiem, meridiem::PM);
                component.imply(Component::Hour, 22);
                component.add_tag("casualReference/evening");
            }
            "manha" | "manhã" => {
                component.imply(Component::Meridiem, meridiem::AM);
                component.imply(Component::Hour, 6);
                component.add_tag("casualReference/morning");
            }
            "meia-noite" => {
                let mut next_day = target_date;
                next_day.set_date(next_day.get_date() + 1);
                assign_similar_date(&mut component, next_day);
                imply_similar_time(&mut component, next_day);
                component.imply(Component::Hour, 0);
                component.imply(Component::Minute, 0);
                component.imply(Component::Second, 0);
                component.add_tag("casualReference/midnight");
            }
            "meio-dia" => {
                component.imply(Component::Meridiem, meridiem::AM);
                component.imply(Component::Hour, 12);
                component.add_tag("casualReference/noon");
            }
            _ => {}
        }
        Extracted::Components(component)
    }
}
