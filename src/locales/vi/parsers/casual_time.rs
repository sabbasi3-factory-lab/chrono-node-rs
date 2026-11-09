//! upstream `locales/vi/parsers/VICasualTimeParser.ts`.

use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::{meridiem, Component, ParsingComponents};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::dates::imply_similar_time;
use crate::js_regex;

pub const UPSTREAM: &str = "VICasualTimeParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(ViCasualTimeParser))
}

struct ViCasualTimeParser;

impl WordBoundaryParser for ViCasualTimeParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        // buổi sáng  |  buổi trưa  |  buổi chiều  |  buổi tối  |  nửa đêm
        js_regex!(r"(buổi\s*)?(sáng sớm|sáng|trưa|chiều|tối|đêm|nửa đêm|bình minh)(?=\W|$)", "i").clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let mut component = context.create_parsing_components(&[]);
        imply_similar_time(&mut component, context.ref_date);
        extract_time_components(&mut component, &m.get(2).unwrap_or("").to_lowercase());
        Extracted::Components(component)
    }
}

/// `VICasualTimeParser.extractTimeComponents(component, keyword)`.
fn extract_time_components(component: &mut ParsingComponents, keyword: &str) {
    let (hour, mer) = match keyword {
        "bình minh" | "sáng sớm" => (6, meridiem::AM),
        "sáng" => (9, meridiem::AM),
        // noon = 12:00 PM in chrono's 12-hour convention
        "trưa" => (12, meridiem::PM),
        "chiều" => (15, meridiem::PM),
        "tối" => (19, meridiem::PM),
        "đêm" => (22, meridiem::PM),
        "nửa đêm" => (0, meridiem::AM),
        _ => return,
    };
    component.imply(Component::Hour, hour);
    component.imply(Component::Minute, 0);
    component.imply(Component::Meridiem, mer);
}
