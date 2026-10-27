//! upstream `common/parsers/SlashDateFormatParser.ts`.

use crate::calculation::years::{find_most_likely_ad_year, find_year_closest_to_ref};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::Component;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::js::js_parse_int;
use crate::js_regex;

pub const UPSTREAM: &str = "SlashDateFormatParser";

pub fn create(flags: &Flags) -> Box<dyn Parser> {
    let little_endian = flags.get("littleEndian");
    Box::new(SlashDateFormatParser {
        group_number_month: if little_endian { SECOND_NUMBERS_GROUP } else { FIRST_NUMBERS_GROUP },
        group_number_day: if little_endian { FIRST_NUMBERS_GROUP } else { SECOND_NUMBERS_GROUP },
    })
}

const OPENING_GROUP: usize = 1;
const ENDING_GROUP: usize = 5;

const FIRST_NUMBERS_GROUP: usize = 2;
const SECOND_NUMBERS_GROUP: usize = 3;

const YEAR_GROUP: usize = 4;

struct SlashDateFormatParser {
    group_number_month: usize,
    group_number_day: usize,
}

impl Parser for SlashDateFormatParser {
    fn pattern(&self, _context: &ParsingContext) -> JsRegex {
        js_regex!(
            concat!(
                r"([^\d]|^)",
                r"([0-3]{0,1}[0-9]{1})[\/\.\-]([0-3]{0,1}[0-9]{1})",
                r"(?:[\/\.\-]([0-9]{4}|[0-9]{2}))?",
                r"(\W|$)"
            ),
            "i"
        )
        .clone()
    }

    fn extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        // The character before the match could still be a number, because the pattern runs on the remaining text.
        let index = m.index + m.get(OPENING_GROUP).unwrap_or("").len();
        let index_end = m.index + m.text().len() - m.get(ENDING_GROUP).unwrap_or("").len();
        if index > 0 {
            let text_before = &context.text[..index];
            if js_regex!(r"\d/?$").is_match(text_before) {
                return Extracted::None;
            }
        }
        if index_end < context.text.len() {
            let text_after = &context.text[index_end..];
            if js_regex!(r"^/?\d").is_match(text_after) {
                return Extracted::None;
            }
        }

        let text = &context.text[index..index_end];

        // '1.12', '1.12.12' is more like a version numbers
        if js_regex!(r"^\d\.\d$").is_match(text) || js_regex!(r"^\d\.\d{1,2}\.\d{1,2}\s*$").is_match(text) {
            return Extracted::None;
        }

        // MM/dd -> OK
        // MM.dd -> NG
        let has_year = m.get(YEAR_GROUP).is_some_and(|s| !s.is_empty());
        if !has_year && !text.contains('/') {
            return Extracted::None;
        }

        let mut result = context.create_parsing_result(index, text, None, None);
        let (Some(mut month), Some(mut day)) = (
            js_parse_int(m.get(self.group_number_month).unwrap_or("")),
            js_parse_int(m.get(self.group_number_day).unwrap_or("")),
        ) else {
            return Extracted::None;
        };
        if month > 12 {
            if (1..=12).contains(&day) && month <= 31 {
                std::mem::swap(&mut day, &mut month);
            } else {
                return Extracted::None;
            }
        }

        if !(1..=31).contains(&day) {
            return Extracted::None;
        }

        result.start.assign(Component::Day, day);
        result.start.assign(Component::Month, month);

        if has_year {
            let raw_year_number = js_parse_int(m.get(YEAR_GROUP).unwrap_or("")).unwrap_or(0);
            let year = find_most_likely_ad_year(raw_year_number);
            result.start.assign(Component::Year, year);
        } else {
            let year = find_year_closest_to_ref(context.ref_date, day, month);
            result.start.imply(Component::Year, year);
        }

        result.add_tag("parser/SlashDateFormatParser");
        Extracted::Result(result)
    }
}
