//! upstream `locales/fi/parsers/FICasualTimeParser.ts`.

use crate::calculation::duration::{Duration, DurationUnit};
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::{meridiem, Component, ParsingComponents};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::dates::imply_similar_time;
use crate::js_regex;

pub const UPSTREAM: &str = "FICasualTimeParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(FiCasualTimeParser))
}

struct FiCasualTimeParser;

impl WordBoundaryParser for FiCasualTimeParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        js_regex!(
            r"(tänä\s*)?(aamulla|aamuna|aamupäivällä|päivällä|iltapäivällä|illalla|yöllä|keskiyöllä)(?=\W|$)",
            "i"
        )
        .clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let keyword = m.get(2).unwrap_or("").to_lowercase();
        let mut component = context.create_parsing_components(&[]);
        imply_similar_time(&mut component, context.ref_date);
        extract_time_components(&mut component, &keyword);
        Extracted::Components(component)
    }
}

fn imply_time(component: &mut ParsingComponents, hour: i64, meridiem: i64) {
    component.imply(Component::Hour, hour);
    component.imply(Component::Minute, 0);
    component.imply(Component::Second, 0);
    component.imply(Component::Meridiem, meridiem);
}

/// `FICasualTimeParser.extractTimeComponents(component, timeKeywordPattern)`.
pub fn extract_time_components(component: &mut ParsingComponents, time_keyword_pattern: &str) {
    match time_keyword_pattern {
        "aamulla" | "aamuna" => {
            imply_time(component, 6, meridiem::AM);
            component.add_tag("casualReference/morning");
        }
        "aamupäivällä" => {
            imply_time(component, 9, meridiem::AM);
            component.add_tag("casualReference/morning");
        }
        "päivällä" => {
            imply_time(component, 12, meridiem::AM);
            component.add_tag("casualReference/noon");
        }
        "iltapäivällä" => {
            imply_time(component, 15, meridiem::PM);
            component.add_tag("casualReference/afternoon");
        }
        "illalla" => {
            imply_time(component, 18, meridiem::PM);
            component.add_tag("casualReference/evening");
        }
        "yöllä" => {
            imply_time(component, 22, meridiem::PM);
            component.add_tag("casualReference/evening");
        }
        "keskiyöllä" => {
            if component.get(Component::Hour).is_some_and(|h| h > 1) {
                component.add_duration_as_implied(&mut Duration::from_pairs(&[(DurationUnit::Day, 1.0)]));
            }
            imply_time(component, 0, meridiem::AM);
            component.add_tag("casualReference/midnight");
        }
        _ => {}
    }
}
