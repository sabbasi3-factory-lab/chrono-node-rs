//! upstream `locales/de/parsers/DESpecificTimeExpressionParser.ts`.

use crate::core::chrono::{Extracted, Parser};
use crate::core::components::{meridiem, Component, ParsingComponents};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::js::js_parse_int;
use crate::js_regex;

pub const UPSTREAM: &str = "DESpecificTimeExpressionParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(DeSpecificTimeExpressionParser)
}

const HOUR_GROUP: usize = 2;
const MINUTE_GROUP: usize = 3;
const SECOND_GROUP: usize = 4;
const AM_PM_HOUR_GROUP: usize = 5;

fn first_reg_pattern() -> &'static JsRegex {
    js_regex!(
        r"(^|\s|T)(?:(?:um|von)\s*)?(\d{1,2})(?:h|:)?(?:(\d{1,2})(?:m|:)?)?(?:(\d{1,2})(?:s)?)?(?:\s*Uhr)?(?:\s*(morgens|vormittags|nachmittags|abends|nachts|am\s+(?:Morgen|Vormittag|Nachmittag|Abend)|in\s+der\s+Nacht))?(?=\W|$)",
        "i"
    )
}

fn second_reg_pattern() -> &'static JsRegex {
    js_regex!(
        r"^\s*(\-|\–|\~|\〜|bis(?:\s+um)?|\?)\s*(\d{1,2})(?:h|:)?(?:(\d{1,2})(?:m|:)?)?(?:(\d{1,2})(?:s)?)?(?:\s*Uhr)?(?:\s*(morgens|vormittags|nachmittags|abends|nachts|am\s+(?:Morgen|Vormittag|Nachmittag|Abend)|in\s+der\s+Nacht))?(?=\W|$)",
        "i"
    )
}

struct DeSpecificTimeExpressionParser;

impl Parser for DeSpecificTimeExpressionParser {
    fn pattern(&self, _context: &ParsingContext) -> JsRegex {
        first_reg_pattern().clone()
    }

    fn extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let prefix_len = m.get(1).unwrap_or("").len();
        let mut result = context.create_parsing_result(m.index + prefix_len, m.text()[prefix_len..].to_string(), None, None);

        // This looks more like a year e.g. 2020
        if js_regex!(r"^\d{4}$").is_match(&result.text) {
            m.index += m.text().len();
            return Extracted::None;
        }

        match extract_time_component(result.start.js_clone(), m) {
            Some(start) => result.start = start,
            None => {
                m.index += m.text().len();
                return Extracted::None;
            }
        }

        let remaining_text = context.text.get(m.index + m.text().len()..).unwrap_or("");
        if let Some(second_match) = second_reg_pattern().exec(remaining_text) {
            result.end = extract_time_component(result.start.js_clone(), &second_match);
            if result.end.is_some() {
                result.text.push_str(second_match.text());
            }
        }

        Extracted::Result(result)
    }
}

fn extract_time_component(mut components: ParsingComponents, m: &RegexMatch) -> Option<ParsingComponents> {
    let mut minute: i64 = 0;
    let mut meridiem_value: Option<i64> = None;

    // parseInt of 1-2 digits is never NaN
    let mut hour = m.get(HOUR_GROUP).and_then(js_parse_int)?;

    if let Some(g) = m.get(MINUTE_GROUP) {
        minute = js_parse_int(g)?;
    }

    if minute >= 60 || hour > 24 {
        return None;
    }

    if hour >= 12 {
        meridiem_value = Some(meridiem::PM);
    }

    if let Some(g) = m.get(AM_PM_HOUR_GROUP) {
        if hour > 12 {
            return None;
        }
        let ampm = g.to_lowercase();
        if js_regex!(r"morgen|vormittag").is_match(&ampm) {
            meridiem_value = Some(meridiem::AM);
            if hour == 12 {
                hour = 0;
            }
        }

        if js_regex!(r"nachmittag|abend").is_match(&ampm) {
            meridiem_value = Some(meridiem::PM);
            if hour != 12 {
                hour += 12;
            }
        }

        if js_regex!(r"nacht").is_match(&ampm) {
            if hour == 12 {
                meridiem_value = Some(meridiem::AM);
                hour = 0;
            } else if hour < 6 {
                meridiem_value = Some(meridiem::AM);
            } else {
                meridiem_value = Some(meridiem::PM);
                hour += 12;
            }
        }
    }

    components.assign(Component::Hour, hour);
    components.assign(Component::Minute, minute);
    match meridiem_value {
        Some(v) => {
            components.assign(Component::Meridiem, v);
        }
        None => {
            if hour < 12 {
                components.imply(Component::Meridiem, meridiem::AM);
            } else {
                components.imply(Component::Meridiem, meridiem::PM);
            }
        }
    }

    if let Some(g) = m.get(SECOND_GROUP) {
        let second = js_parse_int(g)?;
        if second >= 60 {
            return None;
        }
        components.assign(Component::Second, second);
    }

    Some(components)
}
