//! upstream `locales/zh/hant/parsers/ZHHantTimeExpressionParser.ts`.

use std::sync::LazyLock;

use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::Component;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::js_date::JsDate;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::js::js_parse_int;
use crate::core::utils::pattern::dict_keys;
use crate::calculation::duration::{Duration, DurationUnit};
use crate::js_regex;

use super::super::constants::{zh_string_to_number, NUMBER};

pub const UPSTREAM: &str = "ZHHantTimeExpressionParser";

fn build_pattern(prefix: &str) -> JsRegex {
    let keys: String = dict_keys(NUMBER).collect::<Vec<_>>().join("");
    let source = format!(
        concat!(
            "{prefix}",
            r"(?:",
            r"(今|明|前|大前|後|大後|聽|昨|尋|琴)(早|朝|晚)|",
            r"(上(?:午|晝)|朝(?:早)|早(?:上)|下(?:午|晝)|晏(?:晝)|晚(?:上)|夜(?:晚)?|中(?:午)|凌(?:晨))|",
            r"(今|明|前|大前|後|大後|聽|昨|尋|琴)(?:日|天)",
            r"(?:[\s,，]*)",
            r"(?:(上(?:午|晝)|朝(?:早)|早(?:上)|下(?:午|晝)|晏(?:晝)|晚(?:上)|夜(?:晚)?|中(?:午)|凌(?:晨)))?",
            r")?",
            r"(?:[\s,，]*)",
            r"(?:(\d+|[{keys}]+)(?:\s*)(?:點|時|:|：)",
            r"(?:\s*)",
            r"(\d+|半|正|整|[{keys}]+)?(?:\s*)(?:分|:|：)?",
            r"(?:\s*)",
            r"(\d+|[{keys}]+)?(?:\s*)(?:秒)?)",
            r"(?:\s*(A.M.|P.M.|AM?|PM?))?"
        ),
        prefix = prefix,
        keys = keys
    );
    JsRegex::new(&source, "i")
}

static FIRST_REG_PATTERN: LazyLock<JsRegex> = LazyLock::new(|| build_pattern(r"(?:由|從|自)?"));
static SECOND_REG_PATTERN: LazyLock<JsRegex> =
    LazyLock::new(|| build_pattern(r"(?:^\s*(?:到|至|\-|\–|\~|\〜)\s*)"));

const DAY_GROUP_1: usize = 1;
const ZH_AM_PM_HOUR_GROUP_1: usize = 2;
const ZH_AM_PM_HOUR_GROUP_2: usize = 3;
const DAY_GROUP_3: usize = 4;
const ZH_AM_PM_HOUR_GROUP_3: usize = 5;
const HOUR_GROUP: usize = 6;
const MINUTE_GROUP: usize = 7;
const SECOND_GROUP: usize = 8;
const AM_PM_HOUR_GROUP: usize = 9;

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(ZhHantTimeExpressionParser))
}

struct ZhHantTimeExpressionParser;

fn non_empty(m: &RegexMatch, i: usize) -> Option<&str> {
    m.get(i).filter(|s| !s.is_empty())
}

fn number_of(s: &str) -> i64 {
    js_parse_int(s).or_else(|| zh_string_to_number(s)).unwrap_or(0)
}

fn shift_day(date: &mut JsDate, day: &str, ref_hours: Option<i64>) {
    match day {
        "明" | "聽" => {
            // Check not "Tomorrow" on late night
            if ref_hours.is_none_or(|h| h > 1) {
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

fn assign_zh_ampm_1(s: &str, hour: &mut i64, meridiem: &mut i64) {
    match s.chars().next() {
        Some('朝') | Some('早') => {
            *meridiem = 0;
            if *hour == 12 {
                *hour = 0;
            }
        }
        Some('晚') => {
            *meridiem = 1;
            if *hour != 12 {
                *hour += 12;
            }
        }
        _ => {}
    }
}

fn assign_zh_ampm_2(s: &str, hour: &mut i64, meridiem: &mut i64) {
    match s.chars().next() {
        Some('上') | Some('朝') | Some('早') | Some('凌') => {
            *meridiem = 0;
            if *hour == 12 {
                *hour = 0;
            }
        }
        Some('下') | Some('晏') | Some('晚') => {
            *meridiem = 1;
            if *hour != 12 {
                *hour += 12;
            }
        }
        _ => {}
    }
}

struct TimeParts {
    second: Option<i64>,
    hour: i64,
    minute: i64,
    meridiem: i64,
    ampm_used: bool,
}

/// The shared hour/minute/second/meridiem logic of the start and the end chunk.
fn parse_time(m: &RegexMatch) -> Option<TimeParts> {
    let mut second = None;
    if let Some(s) = non_empty(m, SECOND_GROUP) {
        let value = number_of(s);
        if value >= 60 {
            return None;
        }
        second = Some(value);
    }

    let mut hour = number_of(m.get(HOUR_GROUP).unwrap_or(""));
    let mut minute = 0;
    let mut meridiem = -1;

    if let Some(s) = non_empty(m, MINUTE_GROUP) {
        minute = match s {
            "半" => 30,
            "正" | "整" => 0,
            _ => number_of(s),
        };
    } else if hour > 100 {
        minute = hour % 100;
        hour = hour.div_euclid(100);
    }

    if minute >= 60 || hour > 24 {
        return None;
    }
    if hour >= 12 {
        meridiem = 1;
    }

    let mut ampm_used = false;
    if let Some(s) = non_empty(m, AM_PM_HOUR_GROUP) {
        ampm_used = true;
        if hour > 12 {
            return None;
        }
        let ampm = s.chars().next().map(|c| c.to_ascii_lowercase());
        if ampm == Some('a') {
            meridiem = 0;
            if hour == 12 {
                hour = 0;
            }
        }
        if ampm == Some('p') {
            meridiem = 1;
            if hour != 12 {
                hour += 12;
            }
        }
    } else if let Some(s) = non_empty(m, ZH_AM_PM_HOUR_GROUP_1) {
        assign_zh_ampm_1(s, &mut hour, &mut meridiem);
    } else if let Some(s) = non_empty(m, ZH_AM_PM_HOUR_GROUP_2) {
        assign_zh_ampm_2(s, &mut hour, &mut meridiem);
    } else if let Some(s) = non_empty(m, ZH_AM_PM_HOUR_GROUP_3) {
        assign_zh_ampm_2(s, &mut hour, &mut meridiem);
    }

    Some(TimeParts { second, hour, minute, meridiem, ampm_used })
}

impl WordBoundaryParser for ZhHantTimeExpressionParser {
    fn pattern_left_boundary(&self) -> &str {
        // Return a capturing group to ensure that the match index is correct in the base class
        // while avoiding matching CJK characters as word boundaries.
        "()"
    }

    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        FIRST_REG_PATTERN.clone()
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
        let ref_hours = Some(context.ref_date.get_hours());

        // ----- Day
        if let Some(day1) = non_empty(m, DAY_GROUP_1) {
            shift_day(&mut start_moment, day1, ref_hours);
            result.start.assign(Component::Day, start_moment.get_date());
            result.start.assign(Component::Month, start_moment.get_month() + 1);
            result.start.assign(Component::Year, start_moment.get_full_year());
        } else if let Some(day3) = non_empty(m, DAY_GROUP_3) {
            shift_day(&mut start_moment, day3, Some(2));
            result.start.assign(Component::Day, start_moment.get_date());
            result.start.assign(Component::Month, start_moment.get_month() + 1);
            result.start.assign(Component::Year, start_moment.get_full_year());
        } else {
            result.start.imply(Component::Day, start_moment.get_date());
            result.start.imply(Component::Month, start_moment.get_month() + 1);
            result.start.imply(Component::Year, start_moment.get_full_year());
        }

        let Some(parts) = parse_time(m) else {
            return Extracted::None;
        };
        if let Some(second) = parts.second {
            result.start.assign(Component::Second, second);
        }
        let (hour, minute, meridiem) = (parts.hour, parts.minute, parts.meridiem);

        result.start.assign(Component::Hour, hour);
        result.start.assign(Component::Minute, minute);

        if meridiem >= 0 {
            result.start.assign(Component::Meridiem, meridiem);
        } else if hour < 12 {
            result.start.imply(Component::Meridiem, 0);
        } else {
            result.start.imply(Component::Meridiem, 1);
        }

        // ==============================================================
        //                  Extracting the 'to' chunk
        // ==============================================================

        let rest = &context.text[result.index + result.text.len()..];
        let Some(second_match) = SECOND_REG_PATTERN.exec(rest) else {
            // Not accept number only result
            if js_regex!(r"^\d+$").is_match(&result.text) {
                return Extracted::None;
            }
            return Extracted::Result(result);
        };

        let mut end_moment = start_moment;
        if non_empty(&second_match, DAY_GROUP_1).is_some() || non_empty(&second_match, DAY_GROUP_3).is_some() {
            // If the end time expression has a relative day specified (e.g. "Tomorrow"),
            // we should reset the end date to the reference date to calculate the relative date correctly.
            end_moment = context.reference.instant;
        }

        let mut end = context.create_parsing_components(&[]);

        // ----- Day
        if let Some(day1) = non_empty(&second_match, DAY_GROUP_1) {
            shift_day(&mut end_moment, day1, ref_hours);
            end.assign(Component::Day, end_moment.get_date());
            end.assign(Component::Month, end_moment.get_month() + 1);
            end.assign(Component::Year, end_moment.get_full_year());
        } else if let Some(day3) = non_empty(&second_match, DAY_GROUP_3) {
            shift_day(&mut end_moment, day3, Some(2));
            end.assign(Component::Day, end_moment.get_date());
            end.assign(Component::Month, end_moment.get_month() + 1);
            end.assign(Component::Year, end_moment.get_full_year());
        } else {
            end.imply(Component::Day, end_moment.get_date());
            end.imply(Component::Month, end_moment.get_month() + 1);
            end.imply(Component::Year, end_moment.get_full_year());
        }

        let Some(parts) = parse_time(&second_match) else {
            return Extracted::None;
        };
        if let Some(second) = parts.second {
            end.assign(Component::Second, second);
        }
        let (hour, minute, meridiem) = (parts.hour, parts.minute, parts.meridiem);

        if parts.ampm_used && !result.start.is_certain(Component::Meridiem) {
            if meridiem == 0 {
                result.start.imply(Component::Meridiem, 0);
                if result.start.get(Component::Hour) == Some(12) {
                    result.start.assign(Component::Hour, 0);
                }
            } else {
                result.start.imply(Component::Meridiem, 1);
                if result.start.get(Component::Hour) != Some(12) {
                    let start_hour = result.start.get_or_zero(Component::Hour);
                    result.start.assign(Component::Hour, start_hour + 12);
                }
            }
        }

        result.text = format!("{}{}", result.text, second_match.text());
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
