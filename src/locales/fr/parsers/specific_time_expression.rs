//! upstream `locales/fr/parsers/FRSpecificTimeExpressionParser.ts`.

use crate::core::chrono::{Extracted, Parser};
use crate::core::components::{meridiem, Component, ParsingComponents};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::js::js_parse_int;
use crate::js_regex;

pub const UPSTREAM: &str = "FRSpecificTimeExpressionParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(FrSpecificTimeExpressionParser)
}

/// 8h10m00s
/// 8h10m00
/// 8h10
const FIRST_REG_PATTERN: &str = concat!(
    r"(^|\s|T)",
    r"(?:(?:[àa])\s*)?",
    r"(\d{1,2})(?:h|:)?",
    r"(?:(\d{1,2})(?:m|:)?)?",
    r"(?:(\d{1,2})(?:s|:)?)?",
    r"(?:\s*(A\.M\.|P\.M\.|AM?|PM?))?",
    r"(?=\W|$)"
);

const SECOND_REG_PATTERN: &str = concat!(
    r"^\s*(\-|\–|\~|\〜|[àa]|\?)\s*",
    r"(\d{1,2})(?:h|:)?",
    r"(?:(\d{1,2})(?:m|:)?)?",
    r"(?:(\d{1,2})(?:s|:)?)?",
    r"(?:\s*(A\.M\.|P\.M\.|AM?|PM?))?",
    r"(?=\W|$)"
);

const HOUR_GROUP: usize = 2;
const MINUTE_GROUP: usize = 3;
const SECOND_GROUP: usize = 4;
const AM_PM_HOUR_GROUP: usize = 5;

struct FrSpecificTimeExpressionParser;

impl Parser for FrSpecificTimeExpressionParser {
    fn pattern(&self, _context: &ParsingContext) -> JsRegex {
        js_regex!(FIRST_REG_PATTERN, "i").clone()
    }

    fn extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let prefix_len = m.get(1).unwrap_or("").len();
        let mut result = context.create_parsing_result(m.index + prefix_len, &m.text()[prefix_len..], None, None);

        // This looks more like a year e.g. 2020
        if js_regex!(r"^\d{4}$").is_match(&result.text) {
            m.index += m.text().len();
            return Extracted::None;
        }

        let Some(start) = extract_time_component(result.start.js_clone(), m) else {
            m.index += m.text().len();
            return Extracted::None;
        };
        result.start = start;

        let remaining_text = &context.text[m.index + m.text().len()..];
        if let Some(second_match) = js_regex!(SECOND_REG_PATTERN, "i").exec(remaining_text) {
            result.end = extract_time_component(result.start.js_clone(), &second_match);
            if result.end.is_some() {
                result.text.push_str(second_match.text());
            }
        }

        Extracted::Result(result)
    }
}

fn extract_time_component(mut extracting_components: ParsingComponents, m: &RegexMatch) -> Option<ParsingComponents> {
    let mut minute = 0;
    let mut meridiem_value = None;

    // ----- Hours
    let mut hour = js_parse_int(m.get(HOUR_GROUP).unwrap_or(""))?;

    // ----- Minutes
    if let Some(s) = m.get(MINUTE_GROUP) {
        minute = js_parse_int(s)?;
    }

    if minute >= 60 || hour > 24 {
        return None;
    }

    if hour >= 12 {
        meridiem_value = Some(meridiem::PM);
    }

    // ----- AM & PM
    if let Some(s) = m.get(AM_PM_HOUR_GROUP) {
        if hour > 12 {
            return None;
        }
        let ampm = s.chars().next().map(|c| c.to_ascii_lowercase());
        if ampm == Some('a') {
            meridiem_value = Some(meridiem::AM);
            if hour == 12 {
                hour = 0;
            }
        }

        if ampm == Some('p') {
            meridiem_value = Some(meridiem::PM);
            if hour != 12 {
                hour += 12;
            }
        }
    }

    extracting_components.assign(Component::Hour, hour);
    extracting_components.assign(Component::Minute, minute);
    if let Some(v) = meridiem_value {
        extracting_components.assign(Component::Meridiem, v);
    } else if hour < 12 {
        extracting_components.imply(Component::Meridiem, meridiem::AM);
    } else {
        extracting_components.imply(Component::Meridiem, meridiem::PM);
    }

    // ----- Second
    if let Some(s) = m.get(SECOND_GROUP) {
        let second = js_parse_int(s)?;
        if second >= 60 {
            return None;
        }
        extracting_components.assign(Component::Second, second);
    }

    Some(extracting_components)
}
