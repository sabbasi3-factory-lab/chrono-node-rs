//! upstream `locales/zh/hant/parsers/ZHHantCasualDateParser.ts`.

use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::Component;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::js_date::JsDate;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::result::ParsingResult;
use crate::js_regex;

pub const UPSTREAM: &str = "ZHHantCasualDateParser";

const NOW_GROUP: usize = 1;
const DAY_GROUP_1: usize = 2;
const TIME_GROUP_1: usize = 3;
const TIME_GROUP_2: usize = 4;
const DAY_GROUP_3: usize = 5;
const TIME_GROUP_3: usize = 6;

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(ZhHantCasualDateParser))
}

struct ZhHantCasualDateParser;

fn non_empty(m: &RegexMatch, i: usize) -> Option<&str> {
    m.get(i).filter(|s| !s.is_empty())
}

fn shift_day(date: &mut JsDate, day: &str, ref_hours: i64) {
    match day {
        "明" | "聽" => {
            // Check not "Tomorrow" on late night
            if ref_hours > 1 {
                date.set_date(date.get_date() + 1);
            }
        }
        "昨" | "尋" | "琴" => date.set_date(date.get_date() - 1),
        "前" => date.set_date(date.get_date() - 2),
        "大前" => date.set_date(date.get_date() - 3),
        "後" => date.set_date(date.get_date() + 2),
        "大後" => date.set_date(date.get_date() + 3),
        _ => {}
    }
}

fn imply_time_of_day(result: &mut ParsingResult, time: &str) {
    match time.chars().next() {
        Some('早') | Some('朝') | Some('上') => {
            result.start.imply(Component::Hour, 6);
        }
        Some('下') | Some('晏') => {
            result.start.imply(Component::Hour, 15);
            result.start.imply(Component::Meridiem, 1);
        }
        Some('中') => {
            result.start.imply(Component::Hour, 12);
            result.start.imply(Component::Meridiem, 1);
        }
        Some('夜') | Some('晚') => {
            result.start.imply(Component::Hour, 22);
            result.start.imply(Component::Meridiem, 1);
        }
        Some('凌') => {
            result.start.imply(Component::Hour, 0);
        }
        _ => {}
    }
}

impl WordBoundaryParser for ZhHantCasualDateParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        js_regex!(
            concat!(
                r"(而家|立(?:刻|即)|即刻)|",
                r"(今|明|前|大前|後|大後|聽|昨|尋|琴)(早|朝|晚)|",
                r"(上(?:午|晝)|朝(?:早)|早(?:上)|下(?:午|晝)|晏(?:晝)|晚(?:上)|夜(?:晚)?|中(?:午)|凌(?:晨))|",
                r"(今|明|前|大前|後|大後|聽|昨|尋|琴)(?:日|天)",
                r"(?:[\s|,|，]*)",
                r"(?:(上(?:午|晝)|朝(?:早)|早(?:上)|下(?:午|晝)|晏(?:晝)|晚(?:上)|夜(?:晚)?|中(?:午)|凌(?:晨)))?"
            ),
            "i"
        )
        .clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let index = m.index;
        let mut result = context.create_parsing_result(index, m.text(), None, None);

        let ref_date = context.ref_date;
        let mut date = ref_date;

        if non_empty(m, NOW_GROUP).is_some() {
            result.start.imply(Component::Hour, ref_date.get_hours());
            result.start.imply(Component::Minute, ref_date.get_minutes());
            result.start.imply(Component::Second, ref_date.get_seconds());
            result.start.imply(Component::Millisecond, ref_date.get_milliseconds());
        } else if let Some(day1) = non_empty(m, DAY_GROUP_1) {
            let time1 = m.get(TIME_GROUP_1);
            shift_day(&mut date, day1, ref_date.get_hours());

            if time1 == Some("早") || time1 == Some("朝") {
                result.start.imply(Component::Hour, 6);
            } else if time1 == Some("晚") {
                result.start.imply(Component::Hour, 22);
                result.start.imply(Component::Meridiem, 1);
            }
        } else if let Some(time2) = non_empty(m, TIME_GROUP_2) {
            imply_time_of_day(&mut result, time2);
        } else if let Some(day3) = non_empty(m, DAY_GROUP_3) {
            shift_day(&mut date, day3, ref_date.get_hours());

            if let Some(time3) = non_empty(m, TIME_GROUP_3) {
                imply_time_of_day(&mut result, time3);
            }
        }

        result.start.assign(Component::Day, date.get_date());
        result.start.assign(Component::Month, date.get_month() + 1);
        result.start.assign(Component::Year, date.get_full_year());

        Extracted::Result(result)
    }
}
