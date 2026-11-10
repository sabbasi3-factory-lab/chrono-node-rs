//! upstream `locales/zh/hans/parsers/ZHHansTimeExpressionParser.ts`.

use std::sync::OnceLock;

use crate::calculation::duration::{Duration, DurationUnit};
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::{Component, ParsingComponents};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::js_date::JsDate;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::js::js_parse_int;
use crate::core::utils::pattern::dict_keys;

use super::super::constants::{zh_string_to_number, NUMBER};

pub const UPSTREAM: &str = "ZHHansTimeExpressionParser";

const DAY_GROUP_1: usize = 1;
const ZH_AM_PM_HOUR_GROUP_1: usize = 2;
const ZH_AM_PM_HOUR_GROUP_2: usize = 3;
const DAY_GROUP_3: usize = 4;
const ZH_AM_PM_HOUR_GROUP_3: usize = 5;
const HOUR_GROUP: usize = 6;
const MINUTE_GROUP: usize = 7;
const SECOND_GROUP: usize = 8;
const AM_PM_HOUR_GROUP: usize = 9;

fn body_pattern() -> String {
    let numbers: String = dict_keys(NUMBER).collect();
    format!(
        concat!(
            "(?:",
            "(今|明|前|大前|后|大后|昨)(早|朝|晚)|",
            "(上(?:午)|早(?:上)|下(?:午)|晚(?:上)|夜(?:晚)?|中(?:午)|凌(?:晨))|",
            r"(今|明|前|大前|后|大后|昨)(?:日|天)",
            r"(?:[\s,，]*)",
            "(?:(上(?:午)|早(?:上)|下(?:午)|晚(?:上)|夜(?:晚)?|中(?:午)|凌(?:晨)))?",
            ")?",
            r"(?:[\s,，]*)",
            r"(?:(\d+|[{n}]+)(?:\s*)(?:点|时|:|：)",
            r"(?:\s*)",
            r"(\d+|半|正|整|[{n}]+)?(?:\s*)(?:分|:|：)?",
            r"(?:\s*)",
            r"(\d+|[{n}]+)?(?:\s*)(?:秒)?)",
            r"(?:\s*(A.M.|P.M.|AM?|PM?))?"
        ),
        n = numbers
    )
}

fn first_pattern() -> &'static JsRegex {
    static P: OnceLock<JsRegex> = OnceLock::new();
    P.get_or_init(|| JsRegex::new(&format!("(?:从|自)?{}", body_pattern()), "i"))
}

fn second_pattern() -> &'static JsRegex {
    static P: OnceLock<JsRegex> = OnceLock::new();
    P.get_or_init(|| JsRegex::new(&format!(r"(?:^\s*(?:到|至|\-|\–|\~|\〜)\s*){}", body_pattern()), "i"))
}

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(ZhHansTimeExpressionParser))
}

struct ZhHansTimeExpressionParser;

fn truthy(m: &RegexMatch, i: usize) -> Option<&str> {
    m.get(i).filter(|s| !s.is_empty())
}

fn parse_num(s: &str) -> Option<i64> {
    js_parse_int(s).or_else(|| zh_string_to_number(s))
}

fn shift_day(date: &mut JsDate, day: &str, ref_hours: i64, check_late_night: bool) {
    match day {
        "明" => {
            // Check not "Tomorrow" on late night
            if !check_late_night || ref_hours > 1 {
                date.set_date(date.get_date() + 1);
            }
        }
        "昨" => date.set_date(date.get_date() - 1),
        "前" => date.set_date(date.get_date() - 2),
        "大前" => date.set_date(date.get_date() - 3),
        "后" => date.set_date(date.get_date() + 2),
        "大后" => date.set_date(date.get_date() + 3),
        _ => {}
    }
}

/// The "----- Day" block, for either the start or the end.
fn assign_day(m: &RegexMatch, date: &mut JsDate, ref_hours: i64, comps: &mut ParsingComponents) {
    if let Some(day1) = truthy(m, DAY_GROUP_1) {
        shift_day(date, day1, ref_hours, true);
        comps.assign(Component::Day, date.get_date());
        comps.assign(Component::Month, date.get_month() + 1);
        comps.assign(Component::Year, date.get_full_year());
    } else if let Some(day3) = truthy(m, DAY_GROUP_3) {
        shift_day(date, day3, ref_hours, false);
        comps.assign(Component::Day, date.get_date());
        comps.assign(Component::Month, date.get_month() + 1);
        comps.assign(Component::Year, date.get_full_year());
    } else {
        comps.imply(Component::Day, date.get_date());
        comps.imply(Component::Month, date.get_month() + 1);
        comps.imply(Component::Year, date.get_full_year());
    }
}

struct Time {
    hour: i64,
    minute: i64,
    meridiem: i64,
}

fn apply_zh_ampm(zh: &str, group: usize, hour: &mut i64, meridiem: &mut i64) {
    let c = zh.chars().next();
    let morning = if group == ZH_AM_PM_HOUR_GROUP_1 {
        c == Some('早')
    } else {
        matches!(c, Some('上') | Some('早') | Some('凌'))
    };
    let evening = if group == ZH_AM_PM_HOUR_GROUP_1 {
        c == Some('晚')
    } else {
        matches!(c, Some('下') | Some('晚'))
    };
    if morning {
        *meridiem = 0;
        if *hour == 12 {
            *hour = 0;
        }
    } else if evening {
        *meridiem = 1;
        if *hour != 12 {
            *hour += 12;
        }
    }
}

/// Second, hour, minute and meridiem blocks (shared by the start and the end). `None` is upstream's `return null`.
fn parse_time(m: &RegexMatch, comps: &mut ParsingComponents) -> Option<Time> {
    let mut meridiem = -1;

    if let Some(s) = truthy(m, SECOND_GROUP) {
        let second = parse_num(s).unwrap_or(0);
        if second >= 60 {
            return None;
        }
        comps.assign(Component::Second, second);
    }

    let mut hour = parse_num(m.get(HOUR_GROUP).unwrap_or("")).unwrap_or(0);
    let mut minute = 0;

    if let Some(s) = truthy(m, MINUTE_GROUP) {
        if s == "半" {
            minute = 30;
        } else if s == "正" || s == "整" {
            minute = 0;
        } else {
            minute = parse_num(s).unwrap_or(0);
        }
    } else if hour > 100 {
        minute = hour % 100;
        hour /= 100;
    }

    if minute >= 60 || hour > 24 {
        return None;
    }
    if hour >= 12 {
        meridiem = 1;
    }

    if let Some(ampm) = truthy(m, AM_PM_HOUR_GROUP) {
        if hour > 12 {
            return None;
        }
        let first = ampm.chars().next().map(|c| c.to_ascii_lowercase());
        if first == Some('a') {
            meridiem = 0;
            if hour == 12 {
                hour = 0;
            }
        }
        if first == Some('p') {
            meridiem = 1;
            if hour != 12 {
                hour += 12;
            }
        }
    } else if let Some(zh) = truthy(m, ZH_AM_PM_HOUR_GROUP_1) {
        apply_zh_ampm(zh, ZH_AM_PM_HOUR_GROUP_1, &mut hour, &mut meridiem);
    } else if let Some(zh) = truthy(m, ZH_AM_PM_HOUR_GROUP_2) {
        apply_zh_ampm(zh, ZH_AM_PM_HOUR_GROUP_2, &mut hour, &mut meridiem);
    } else if let Some(zh) = truthy(m, ZH_AM_PM_HOUR_GROUP_3) {
        apply_zh_ampm(zh, ZH_AM_PM_HOUR_GROUP_3, &mut hour, &mut meridiem);
    }

    Some(Time { hour, minute, meridiem })
}

impl WordBoundaryParser for ZhHansTimeExpressionParser {
    fn pattern_left_boundary(&self) -> &str {
        // Return a capturing group to ensure that the match index is correct in the base class
        // while avoiding matching CJK characters as word boundaries.
        "()"
    }

    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        first_pattern().clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        // This pattern can be overlaped Ex. [12] AM, 1[2] AM
        if m.index > 0 {
            if let Some(prev) = context.text[..m.index].chars().next_back() {
                if prev.is_ascii_alphanumeric() || prev == '_' {
                    return Extracted::None;
                }
            }
        }

        let mut result = context.create_parsing_result(m.index, m.text(), None, None);
        let mut start_moment = context.reference.instant;
        let ref_hours = context.reference.instant.get_hours();

        assign_day(m, &mut start_moment, ref_hours, &mut result.start);

        let Some(time) = parse_time(m, &mut result.start) else {
            return Extracted::None;
        };
        let Time { hour, minute, meridiem } = time;

        result.start.assign(Component::Hour, hour);
        result.start.assign(Component::Minute, minute);

        if meridiem >= 0 {
            result.start.assign(Component::Meridiem, meridiem);
        } else if hour < 12 {
            result.start.imply(Component::Meridiem, 0);
        } else {
            result.start.imply(Component::Meridiem, 1);
        }

        // ----- Extracting the 'to' chunk
        let rest = context.text.get(result.index + result.text.len()..).unwrap_or("");
        let Some(second_match) = second_pattern().exec(rest) else {
            // Not accept number only result
            if !result.text.is_empty() && result.text.bytes().all(|b| b.is_ascii_digit()) {
                return Extracted::None;
            }
            return Extracted::Result(result);
        };

        let mut end_moment = start_moment;
        if truthy(&second_match, DAY_GROUP_1).is_some() || truthy(&second_match, DAY_GROUP_3).is_some() {
            // If the end time expression has a relative day specified (e.g. "Tomorrow"),
            // we should reset the end date to the reference date to calculate the relative date correctly.
            end_moment = context.reference.instant;
        }
        let mut end = context.create_parsing_components(&[]);

        assign_day(&second_match, &mut end_moment, ref_hours, &mut end);

        let Some(time) = parse_time(&second_match, &mut end) else {
            return Extracted::None;
        };
        let Time { hour, minute, meridiem } = time;

        if truthy(&second_match, AM_PM_HOUR_GROUP).is_some() && !result.start.is_certain(Component::Meridiem) {
            if meridiem == 0 {
                result.start.imply(Component::Meridiem, 0);
                if result.start.get(Component::Hour) == Some(12) {
                    result.start.assign(Component::Hour, 0);
                }
            } else {
                result.start.imply(Component::Meridiem, 1);
                if result.start.get(Component::Hour) != Some(12) {
                    let h = result.start.get_or_zero(Component::Hour);
                    result.start.assign(Component::Hour, h + 12);
                }
            }
        }

        result.text.push_str(second_match.text());
        end.assign(Component::Hour, hour);
        end.assign(Component::Minute, minute);
        if meridiem >= 0 {
            end.assign(Component::Meridiem, meridiem);
        } else {
            let start_at_pm =
                result.start.is_certain(Component::Meridiem) && result.start.get(Component::Meridiem) == Some(1);
            if start_at_pm && result.start.get_or_zero(Component::Hour) > hour {
                // 10pm - 1 (am)
                end.imply(Component::Meridiem, 0);
            } else if hour > 12 {
                end.imply(Component::Meridiem, 1);
            }
        }

        if let (Some(e), Some(s)) = (end.date().get_time(), result.start.date().get_time()) {
            if e < s && !end.is_certain(Component::Day) {
                end.add_duration_as_implied(&mut Duration::from_pairs(&[(DurationUnit::Day, 1.0)]));
            }
        }

        result.end = Some(end);
        Extracted::Result(result)
    }
}
