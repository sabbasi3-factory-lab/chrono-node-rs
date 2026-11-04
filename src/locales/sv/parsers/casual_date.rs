//! upstream `locales/sv/parsers/SVCasualDateParser.ts`.

use crate::common::casual_references as references;
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::Component;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::dates::{assign_similar_date, imply_similar_time};
use crate::js_regex;

pub const UPSTREAM: &str = "SVCasualDateParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(SvCasualDateParser))
}

struct SvCasualDateParser;

impl WordBoundaryParser for SvCasualDateParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        js_regex!(
            r"(nu|idag|imorgon|övermorgon|igår|förrgår|i\s*förrgår)(?:\s*(?:på\s*)?(morgonen?|förmiddagen?|middagen?|eftermiddagen?|kvällen?|natten?|midnatt))?(?=\W|$)",
            "i"
        )
        .clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let target_date = context.ref_date;
        let date_keyword = m.get(1).unwrap_or("").to_lowercase();
        let time_keyword = m.get(2).unwrap_or("").to_lowercase();

        let mut component = context.create_parsing_components(&[]);
        let day_offset = match date_keyword.as_str() {
            "nu" => {
                component = references::now(context.reference);
                None
            }
            "idag" => {
                component = references::today(context.reference);
                None
            }
            "imorgon" | "imorn" => Some(1),
            "igår" => Some(-1),
            "förrgår" | "i förrgår" => Some(-2),
            _ => None,
        };
        if let Some(offset) = day_offset {
            let mut date = target_date;
            date.set_date(date.get_date() + offset);
            assign_similar_date(&mut component, date);
            imply_similar_time(&mut component, date);
        }

        let hour = match time_keyword.as_str() {
            "morgon" | "morgonen" => Some(6),
            "förmiddag" | "förmiddagen" => Some(9),
            "middag" | "middagen" => Some(12),
            "eftermiddag" | "eftermiddagen" => Some(15),
            "kväll" | "kvällen" => Some(20),
            "natt" | "natten" => Some(2),
            "midnatt" => Some(0),
            _ => None,
        };
        if let Some(hour) = hour {
            component.imply(Component::Hour, hour);
            component.imply(Component::Minute, 0);
            component.imply(Component::Second, 0);
            component.imply(Component::Millisecond, 0);
        }
        Extracted::Components(component)
    }
}
