//! upstream `locales/nl/parsers/NLCasualTimeParser.ts`.

use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::{meridiem, Component};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::dates::{assign_similar_date, imply_similar_time};
use crate::js_regex;

pub const UPSTREAM: &str = "NLCasualTimeParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(NlCasualTimeParser))
}

struct NlCasualTimeParser;

impl WordBoundaryParser for NlCasualTimeParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        js_regex!(
            r"(deze)?\s*(namiddag|avond|middernacht|ochtend|middag|'s middags|'s avonds|'s ochtends)(?=\W|$)",
            "i"
        )
        .clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let target_date = context.ref_date;
        let mut component = context.create_parsing_components(&[]);

        if m.get(1) == Some("deze") {
            component.assign(Component::Day, context.ref_date.get_date());
            component.assign(Component::Month, context.ref_date.get_month() + 1);
            component.assign(Component::Year, context.ref_date.get_full_year());
        }

        // Upstream's `'s namiddags` and `'s avonds'` cases can never match the pattern; kept out.
        match m.get(2).unwrap_or("").to_lowercase().as_str() {
            "namiddag" => {
                component.imply(Component::Meridiem, meridiem::PM);
                component.imply(Component::Hour, 15);
                component.add_tag("casualReference/afternoon");
            }
            "avond" => {
                component.imply(Component::Meridiem, meridiem::PM);
                component.imply(Component::Hour, 20);
                component.add_tag("casualReference/evening");
            }
            "middernacht" => {
                let mut next_day = target_date;
                next_day.set_date(next_day.get_date() + 1);
                assign_similar_date(&mut component, next_day);
                imply_similar_time(&mut component, next_day);
                component.imply(Component::Hour, 0);
                component.imply(Component::Minute, 0);
                component.imply(Component::Second, 0);
                component.add_tag("casualReference/midnight");
            }
            "ochtend" | "'s ochtends" => {
                component.imply(Component::Meridiem, meridiem::AM);
                component.imply(Component::Hour, 6);
                component.add_tag("casualReference/morning");
            }
            "middag" | "'s middags" => {
                component.imply(Component::Meridiem, meridiem::AM);
                component.imply(Component::Hour, 12);
                component.add_tag("casualReference/noon");
            }
            _ => {}
        }

        Extracted::Components(component)
    }
}
