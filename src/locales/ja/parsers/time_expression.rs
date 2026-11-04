//! upstream `locales/ja/parsers/JPTimeExpressionParser.ts`.

use std::sync::LazyLock;

use crate::calculation::duration::{Duration, DurationUnit};
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::{meridiem, Component, ParsingComponents};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::js::js_parse_int;
use crate::locales::ja::constants::{ja_string_to_number, to_hankaku, NUMBER};

pub const UPSTREAM: &str = "JPTimeExpressionParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(JpTimeExpressionParser))
}

fn number_keys() -> String {
    NUMBER.iter().map(|(k, _)| *k).collect::<String>()
}

static FIRST_REG_PATTERN: LazyLock<JsRegex> = LazyLock::new(|| {
    let n = number_keys();
    JsRegex::new(
        &format!(
            concat!(
                r"(?:(午前|午後|A.M.|P.M.|AM|PM))?",
                r"(?:[\s,，、]*)",
                r"(?:([0-9０-９]+|[{n}]+)(?:\s*)(?:時(?!間)|:|：)",
                r"(?:\s*)",
                r"([0-9０-９]+|半|[{n}]+)?(?:\s*)(?:分|:|：)?",
                r"(?:\s*)",
                r"([0-9０-９]+|[{n}]+)?(?:\s*)(?:秒)?)",
                r"(?:\s*(A.M.|P.M.|AM?|PM?))?",
            ),
            n = n
        ),
        "i",
    )
});

static SECOND_REG_PATTERN: LazyLock<JsRegex> = LazyLock::new(|| {
    let n = number_keys();
    JsRegex::new(
        &format!(
            concat!(
                r"(?:^\s*(?:から|\-|\–|\－|\~|\〜)\s*)",
                r"(?:(午前|午後|A.M.|P.M.|AM|PM))?",
                r"(?:[\s,，、]*)",
                r"(?:([0-9０-９]+|[{n}]+)(?:\s*)(?:時|:|：)",
                r"(?:\s*)",
                r"([0-9０-９]+|半|[{n}]+)?(?:\s*)(?:分|:|：)?",
                r"(?:\s*)",
                r"([0-9０-９]+|[{n}]+)?(?:\s*)(?:秒)?)",
                r"(?:\s*(A.M.|P.M.|AM?|PM?))?",
            ),
            n = n
        ),
        "i",
    )
});

const AM_PM_HOUR_GROUP_1: usize = 1;
const HOUR_GROUP: usize = 2;
const MINUTE_GROUP: usize = 3;
const SECOND_GROUP: usize = 4;
const AM_PM_HOUR_GROUP_2: usize = 5;

struct JpTimeExpressionParser;

/// `match[1] ?? match[5]`.
fn am_pm(m: &RegexMatch) -> Option<String> {
    m.get(AM_PM_HOUR_GROUP_1)
        .or_else(|| m.get(AM_PM_HOUR_GROUP_2))
        .map(str::to_string)
}

impl WordBoundaryParser for JpTimeExpressionParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        FIRST_REG_PATTERN.clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        // This pattern can be overlapped Ex. [12] AM, 1[2] AM
        if m.index > 0 {
            if let Some(prev) = context.text[..m.index].chars().next_back() {
                if prev.is_ascii_alphanumeric() || prev == '_' {
                    return Extracted::None;
                }
            }
        }

        let mut result = context.create_parsing_result(m.index, m.text(), None, None);
        let start = create_time_components(
            context,
            m.get(HOUR_GROUP),
            m.get(MINUTE_GROUP),
            m.get(SECOND_GROUP),
            am_pm(m).as_deref(),
        );
        match start {
            Some(start) => result.start = start,
            None => {
                m.index += m.text().len(); // Skip over potential overlapping pattern
                return Extracted::None;
            }
        }

        let rest = context.text.get(result.index + result.text.len()..).unwrap_or("");
        let Some(m2) = SECOND_REG_PATTERN.exec(rest) else {
            return Extracted::Result(result);
        };

        result.text.push_str(m2.text());
        let Some(mut end) = create_time_components(
            context,
            m2.get(HOUR_GROUP),
            m2.get(MINUTE_GROUP),
            m2.get(SECOND_GROUP),
            am_pm(&m2).as_deref(),
        ) else {
            return Extracted::None;
        };
        if !end.is_certain(Component::Meridiem) && result.start.is_certain(Component::Meridiem) {
            let start_meridiem = result.start.get_or_zero(Component::Meridiem);
            end.imply(Component::Meridiem, start_meridiem);
            if start_meridiem == meridiem::PM {
                let end_hour = end.get_or_zero(Component::Hour);
                if result.start.get_or_zero(Component::Hour) - 12 > end_hour {
                    // 10pm - 1 (am)
                    end.imply(Component::Meridiem, meridiem::AM);
                } else if end_hour < 12 {
                    end.assign(Component::Hour, end_hour + 12);
                }
            }
        }
        if let (Some(e), Some(s)) = (end.date().get_time(), result.start.date().get_time()) {
            if e < s {
                end.add_duration_as_implied(&mut Duration::from_pairs(&[(DurationUnit::Day, 1.0)]));
            }
        }
        result.end = Some(end);
        Extracted::Result(result)
    }
}

/// `parseInt(toHankaku(s))`, falling back to `jaStringToNumber`; `None` is `NaN`.
fn parse_number(s: &str) -> Option<i64> {
    js_parse_int(&to_hankaku(s)).or_else(|| ja_string_to_number(s))
}

fn create_time_components(
    context: &ParsingContext,
    match_hour: Option<&str>,
    match_minute: Option<&str>,
    match_second: Option<&str>,
    match_am_pm: Option<&str>,
) -> Option<ParsingComponents> {
    let mut meridiem_value: i64 = -1;
    let mut target = context.create_parsing_components(&[]);
    let mut hour = parse_number(match_hour.unwrap_or(""))?;
    if hour > 24 {
        return None;
    }

    if let Some(mm) = match_minute.filter(|s| !s.is_empty()) {
        let minute = if mm == "半" { 30 } else { parse_number(mm)? };
        if minute >= 60 {
            return None;
        }
        target.assign(Component::Minute, minute);
    }
    if let Some(ms) = match_second.filter(|s| !s.is_empty()) {
        let second = parse_number(ms)?;
        if second >= 60 {
            return None;
        }
        target.assign(Component::Second, second);
    }

    if let Some(ap) = match_am_pm.filter(|s| !s.is_empty()) {
        if hour > 12 {
            return None;
        }
        let first = ap.chars().next().map(|c| c.to_lowercase().collect::<String>()).unwrap_or_default();
        if ap == "午前" || first == "a" {
            meridiem_value = meridiem::AM;
            if hour == 12 {
                hour = 0;
            }
        } else if ap == "午後" || first == "p" {
            meridiem_value = meridiem::PM;
            if hour != 12 {
                hour += 12;
            }
        }
    }

    target.assign(Component::Hour, hour);

    if meridiem_value >= 0 {
        target.assign(Component::Meridiem, meridiem_value);
    } else if hour < 12 {
        target.imply(Component::Meridiem, meridiem::AM);
    } else {
        target.imply(Component::Meridiem, meridiem::PM);
    }
    Some(target)
}
