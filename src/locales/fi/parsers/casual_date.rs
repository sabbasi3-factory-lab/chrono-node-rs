//! upstream `locales/fi/parsers/FICasualDateParser.ts`.

use super::casual_time::extract_time_components;
use crate::calculation::duration::{add_duration, Duration, DurationUnit};
use crate::common::casual_references as references;
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::Component;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::dates::{assign_similar_date, imply_similar_time};
use crate::js_regex;

pub const UPSTREAM: &str = "FICasualDateParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(FiCasualDateParser))
}

struct FiCasualDateParser;

impl WordBoundaryParser for FiCasualDateParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        js_regex!(
            r"(nyt|tänään|huomenna|ylihuomenna|eilen|toissapäivänä|viime\s*yönä)(?:\s*(aamulla|aamuna|aamupäivällä|päivällä|iltapäivällä|illalla|yöllä|keskiyöllä))?(?=\W|$)",
            "i"
        )
        .clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let mut target_date = context.reference.get_date_with_adjusted_timezone();
        let date_keyword = m.get(1).unwrap_or("").to_lowercase();
        let time_keyword = m.get(2).unwrap_or("").to_lowercase();

        let mut component = context.create_parsing_components(&[]);
        let shift = |days: f64| Duration::from_pairs(&[(DurationUnit::Day, days)]);
        match date_keyword.as_str() {
            "nyt" => component = references::now(context.reference),
            "tänään" => component = references::today(context.reference),
            "huomenna" | "ylihuomenna" | "eilen" | "toissapäivänä" => {
                let days = match date_keyword.as_str() {
                    "huomenna" => 1.0,
                    "ylihuomenna" => 2.0,
                    "eilen" => -1.0,
                    _ => -2.0,
                };
                target_date = add_duration(target_date, &mut shift(days));
                assign_similar_date(&mut component, target_date);
                imply_similar_time(&mut component, target_date);
            }
            _ => {
                if js_regex!(r"viime\s*yönä").is_match(&date_keyword) {
                    if target_date.get_hours() > 6 {
                        target_date = add_duration(target_date, &mut shift(-1.0));
                    }
                    assign_similar_date(&mut component, target_date);
                    component.imply(Component::Hour, 0);
                }
            }
        }

        if !time_keyword.is_empty() {
            extract_time_components(&mut component, &time_keyword);
        }
        Extracted::Components(component)
    }
}
