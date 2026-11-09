//! upstream `locales/vi/parsers/VITimeExpressionParser.ts`.

use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::{meridiem, Component};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::js::js_parse_int;
use crate::js_regex;

pub const UPSTREAM: &str = "VITimeExpressionParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(ViTimeExpressionParser))
}

const HOUR_GROUP: usize = 1;
const MINUTE_GIO_GROUP: usize = 2;
const MERIDIEM_GROUP: usize = 3;
const MINUTE_COLON_GROUP: usize = 4;

struct ViTimeExpressionParser;

/// JS truthiness of `match[i]`: `undefined` and `""` are false.
fn truthy(m: &RegexMatch, i: usize) -> Option<&str> {
    m.get(i).filter(|s| !s.is_empty())
}

impl WordBoundaryParser for ViTimeExpressionParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        // lúc 7 giờ 30 phút  |  7 giờ sáng  |  7 giờ  |  15:30
        js_regex!(
            concat!(
                r"(?:lúc\s*|vào\s*)?",
                r"([0-9]{1,2})",
                r"(?:\s*giờ\s*([0-9]{1,2})?\s*(?:phút\s*)?",
                r"(sáng|trưa|chiều|tối|đêm)?",
                r"|:([0-9]{2}))",
                r"(?=\W|$)",
            ),
            "i"
        )
        .clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        // `hour > 23` is false for NaN; the group is always digits here.
        let Some(hour) = js_parse_int(m.get(HOUR_GROUP).unwrap_or("")) else {
            return Extracted::None;
        };
        if hour > 23 {
            return Extracted::None;
        }

        let mut result = context.create_parsing_result(m.index, m.text(), None, None);
        result.start.assign(Component::Hour, hour);

        let minute = if let Some(s) = truthy(m, MINUTE_COLON_GROUP) {
            js_parse_int(s)
        } else if let Some(s) = truthy(m, MINUTE_GIO_GROUP) {
            js_parse_int(s)
        } else {
            Some(0)
        };
        let Some(minute) = minute else {
            return Extracted::None;
        };
        if minute >= 60 {
            return Extracted::None;
        }
        result.start.assign(Component::Minute, minute);

        let mer = m.get(MERIDIEM_GROUP).map(|s| s.to_lowercase());
        match mer.as_deref() {
            Some("sáng") => {
                // "12 giờ sáng" = midnight (00:00), matching EN convention
                result.start.assign(Component::Meridiem, meridiem::AM);
                if hour == 12 {
                    result.start.assign(Component::Hour, 0);
                }
            }
            Some("trưa") => {
                // "1 giờ trưa" = 13:00, but "11 giờ trưa" = 11:00 (approaching noon)
                if hour < 10 {
                    result.start.assign(Component::Meridiem, meridiem::PM);
                    result.start.assign(Component::Hour, hour + 12);
                } else {
                    // 10-12: keep as-is (AM for 10-11, PM for 12)
                    result
                        .start
                        .assign(Component::Meridiem, if hour >= 12 { meridiem::PM } else { meridiem::AM });
                }
            }
            Some("chiều") | Some("tối") | Some("đêm") => {
                result.start.assign(Component::Meridiem, meridiem::PM);
                if hour < 12 {
                    result.start.assign(Component::Hour, hour + 12);
                }
            }
            _ => {}
        }

        result.start.imply(Component::Second, 0);
        result.start.imply(Component::Millisecond, 0);
        Extracted::Result(result)
    }
}
