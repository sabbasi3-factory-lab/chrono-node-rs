//! upstream `common/parsers/ISOFormatParser.ts`.

use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::Component;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::js::js_parse_int;
use crate::js_regex;

pub const UPSTREAM: &str = "ISOFormatParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(IsoFormatParser))
}

const YEAR_NUMBER_GROUP: usize = 1;
const MONTH_NUMBER_GROUP: usize = 2;
const DATE_NUMBER_GROUP: usize = 3;
const HOUR_NUMBER_GROUP: usize = 4;
const MINUTE_NUMBER_GROUP: usize = 5;
const SECOND_NUMBER_GROUP: usize = 6;
const MILLISECOND_NUMBER_GROUP: usize = 7;
const TZD_GROUP: usize = 8;
const TZD_HOUR_OFFSET_GROUP: usize = 9;
const TZD_MINUTE_OFFSET_GROUP: usize = 10;

struct IsoFormatParser;

fn int(m: &RegexMatch, group: usize) -> i64 {
    js_parse_int(m.get(group).unwrap_or("")).unwrap_or(0)
}

impl WordBoundaryParser for IsoFormatParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        js_regex!(
            concat!(
                r"([0-9]{4})\-([0-9]{1,2})\-([0-9]{1,2})",
                r"(?:T",
                r"([0-9]{1,2}):([0-9]{1,2})",
                r"(?:",
                r":([0-9]{1,2})(?:\.(\d{1,4}))?",
                r")?",
                r"(",
                r"Z|([+-]\d{2}):?(\d{2})?",
                r")?",
                r")?",
                r"(?=\W|$)"
            ),
            "i"
        )
        .clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let mut components = context.create_parsing_components(&[
            (Component::Year, int(m, YEAR_NUMBER_GROUP)),
            (Component::Month, int(m, MONTH_NUMBER_GROUP)),
            (Component::Day, int(m, DATE_NUMBER_GROUP)),
        ]);
        if m.get(HOUR_NUMBER_GROUP).is_some() {
            components.assign(Component::Hour, int(m, HOUR_NUMBER_GROUP));
            components.assign(Component::Minute, int(m, MINUTE_NUMBER_GROUP));

            if m.get(SECOND_NUMBER_GROUP).is_some() {
                components.assign(Component::Second, int(m, SECOND_NUMBER_GROUP));
            }

            if m.get(MILLISECOND_NUMBER_GROUP).is_some() {
                components.assign(Component::Millisecond, int(m, MILLISECOND_NUMBER_GROUP));
            }
            if m.get(TZD_GROUP).is_some() {
                // The Zulu time zone (Z) is equivalent to UTC
                let mut offset = 0;
                if m.get(TZD_HOUR_OFFSET_GROUP).is_some_and(|s| !s.is_empty()) {
                    let hour_offset = int(m, TZD_HOUR_OFFSET_GROUP);
                    let mut minute_offset = 0;
                    if m.get(TZD_MINUTE_OFFSET_GROUP).is_some() {
                        minute_offset = int(m, TZD_MINUTE_OFFSET_GROUP);
                    }
                    offset = hour_offset * 60;
                    if offset < 0 {
                        offset -= minute_offset;
                    } else {
                        offset += minute_offset;
                    }
                }
                components.assign(Component::TimezoneOffset, offset);
            }
        }
        components.add_tag("parser/ISOFormatParser");
        Extracted::Components(components)
    }
}
