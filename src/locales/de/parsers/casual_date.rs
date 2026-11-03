//! upstream `locales/de/parsers/DECasualDateParser.ts`.

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
use crate::locales::de::casual_time_components::extract_time_components;

pub const UPSTREAM: &str = "DECasualDateParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(DeCasualDateParser))
}

struct DeCasualDateParser;

impl WordBoundaryParser for DeCasualDateParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        js_regex!(
            r"(jetzt|heute|morgen|übermorgen|uebermorgen|gestern|vorgestern|letzte\s*nacht)(?:\s*(morgen|vormittag|mittags?|nachmittag|abend|nacht|mitternacht))?(?=\W|$)",
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
            "jetzt" => component = references::now(context.reference),
            "heute" => component = references::today(context.reference),
            "morgen" | "übermorgen" | "uebermorgen" | "gestern" | "vorgestern" => {
                let days = match date_keyword.as_str() {
                    "morgen" => 1.0,
                    "gestern" => -1.0,
                    "vorgestern" => -2.0,
                    _ => 2.0,
                };
                target_date = add_duration(target_date, &mut shift(days));
                assign_similar_date(&mut component, target_date);
                imply_similar_time(&mut component, target_date);
            }
            _ => {
                if js_regex!(r"letzte\s*nacht").is_match(&date_keyword) {
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
