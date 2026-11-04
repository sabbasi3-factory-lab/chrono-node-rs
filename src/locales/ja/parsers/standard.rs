//! upstream `locales/ja/parsers/JPStandardParser.ts`.

use crate::calculation::years::find_year_closest_to_ref;
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::Component;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::js::js_parse_int;
use crate::js_regex;
use crate::locales::ja::constants::to_hankaku;

pub const UPSTREAM: &str = "JPStandardParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(JpStandardParser)
}

const PATTERN: &str = r"(?:(?:([同今本])|((昭和|平成|令和)?([0-9０-９]{1,4}|元)))年\s*)?([0-9０-９]{1,2})月\s*([0-9０-９]{1,2})日";
const SPECIAL_YEAR_GROUP: usize = 1;
const TYPICAL_YEAR_GROUP: usize = 2;
const ERA_GROUP: usize = 3;
const YEAR_NUMBER_GROUP: usize = 4;
const MONTH_GROUP: usize = 5;
const DAY_GROUP: usize = 6;

struct JpStandardParser;

impl Parser for JpStandardParser {
    fn pattern(&self, _context: &ParsingContext) -> JsRegex {
        js_regex!(PATTERN, "i").clone()
    }

    fn extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let month = js_parse_int(&to_hankaku(m.get(MONTH_GROUP).unwrap_or(""))).unwrap_or(0);
        let day = js_parse_int(&to_hankaku(m.get(DAY_GROUP).unwrap_or(""))).unwrap_or(0);
        let mut components = context.create_parsing_components(&[(Component::Day, day), (Component::Month, month)]);

        if m.get(SPECIAL_YEAR_GROUP).is_some_and(|s| !s.is_empty()) {
            components.assign(
                Component::Year,
                context.reference.get_date_with_adjusted_timezone().get_full_year(),
            );
        }

        if m.get(TYPICAL_YEAR_GROUP).is_some_and(|s| !s.is_empty()) {
            let year_num_text = m.get(YEAR_NUMBER_GROUP).unwrap_or("");

            let mut year = if year_num_text == "元" {
                1
            } else {
                js_parse_int(&to_hankaku(year_num_text)).unwrap_or(0)
            };
            match m.get(ERA_GROUP) {
                Some("令和") => year += 2018,
                Some("平成") => year += 1988,
                Some("昭和") => year += 1925,
                _ => {}
            }

            components.assign(Component::Year, year);
        } else {
            let year = find_year_closest_to_ref(context.ref_date, day, month);
            components.imply(Component::Year, year);
        }

        Extracted::Components(components)
    }
}
