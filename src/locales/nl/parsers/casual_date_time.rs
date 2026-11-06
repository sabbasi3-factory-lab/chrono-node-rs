//! upstream `locales/nl/parsers/NLCasualDateTimeParser.ts`.

use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::{meridiem, Component};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::dates::{assign_similar_date, imply_similar_time};
use crate::js_regex;

pub const UPSTREAM: &str = "NLCasualDateTimeParser";

const DATE_GROUP: usize = 1;
const TIME_OF_DAY_GROUP: usize = 2;

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(NlCasualDateTimeParser))
}

struct NlCasualDateTimeParser;

impl WordBoundaryParser for NlCasualDateTimeParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        js_regex!(
            r"(gisteren|morgen|van)(ochtend|middag|namiddag|avond|nacht)(?=\W|$)",
            "i"
        )
        .clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let date_text = m.get(DATE_GROUP).unwrap_or("").to_lowercase();
        let time_text = m.get(TIME_OF_DAY_GROUP).unwrap_or("").to_lowercase();
        let mut component = context.create_parsing_components(&[]);
        let target_date = context.ref_date;

        match date_text.as_str() {
            "gisteren" => {
                let mut previous_day = target_date;
                previous_day.set_date(previous_day.get_date() - 1);
                assign_similar_date(&mut component, previous_day);
            }
            "van" => assign_similar_date(&mut component, target_date),
            "morgen" => {
                let mut next_day = target_date;
                next_day.set_date(next_day.get_date() + 1);
                assign_similar_date(&mut component, next_day);
                imply_similar_time(&mut component, next_day);
            }
            _ => {}
        }

        match time_text.as_str() {
            "ochtend" => {
                component.imply(Component::Meridiem, meridiem::AM);
                component.imply(Component::Hour, 6);
            }
            "middag" => {
                component.imply(Component::Meridiem, meridiem::AM);
                component.imply(Component::Hour, 12);
            }
            "namiddag" => {
                component.imply(Component::Meridiem, meridiem::PM);
                component.imply(Component::Hour, 15);
            }
            "avond" => {
                component.imply(Component::Meridiem, meridiem::PM);
                component.imply(Component::Hour, 20);
            }
            _ => {}
        }

        Extracted::Components(component)
    }
}
