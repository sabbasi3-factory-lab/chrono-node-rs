//! upstream `locales/ja/parsers/JPSlashDateFormatParser.ts`.

use crate::calculation::years::{find_most_likely_ad_year, find_year_closest_to_ref};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::Component;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::js::js_parse_int;
use crate::js_regex;
use crate::locales::ja::constants::to_hankaku;

pub const UPSTREAM: &str = "JPSlashDateFormatParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(JpSlashDateFormatParser)
}

const PATTERN: &str =
    r"([0-9０-９]{4}[\/|\／])?([0-1０-１]{0,1}[0-9０-９]{1})(?:[\/|\／]([0-3０-３]{0,1}[0-9０-９]{1}))";
const YEAR_GROUP: usize = 1;
const MONTH_GROUP: usize = 2;
const DAY_GROUP: usize = 3;

struct JpSlashDateFormatParser;

impl Parser for JpSlashDateFormatParser {
    fn pattern(&self, _context: &ParsingContext) -> JsRegex {
        js_regex!(PATTERN, "i").clone()
    }

    fn extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let mut result = context.create_parsing_components(&[]);
        let month = js_parse_int(&to_hankaku(m.get(MONTH_GROUP).unwrap_or(""))).unwrap_or(0);
        let day = js_parse_int(&to_hankaku(m.get(DAY_GROUP).unwrap_or(""))).unwrap_or(0);
        if !(1..=12).contains(&month) {
            return Extracted::None;
        }

        if !(1..=31).contains(&day) {
            return Extracted::None;
        }

        result.assign(Component::Day, day);
        result.assign(Component::Month, month);

        if m.get(YEAR_GROUP).is_some_and(|s| !s.is_empty()) {
            let raw_year_number = js_parse_int(&to_hankaku(m.get(YEAR_GROUP).unwrap_or(""))).unwrap_or(0);
            let year = find_most_likely_ad_year(raw_year_number);
            result.assign(Component::Year, year);
        } else {
            let year = find_year_closest_to_ref(context.ref_date, day, month);
            result.imply(Component::Year, year);
        }

        Extracted::Components(result)
    }
}
