//! upstream `calculation/mergingCalculation.ts`.

use crate::core::components::{meridiem, Component, ParsingComponents};
use crate::core::js_date::JsDate;
use crate::core::result::ParsingResult;
use crate::core::utils::dates::{assign_similar_date, imply_similar_date};

/// `mergeDateTimeResult(dateResult, timeResult)`.
pub fn merge_date_time_result(date_result: &ParsingResult, time_result: &ParsingResult) -> ParsingResult {
    let mut result = date_result.clone();
    result.start = merge_date_time_component(&date_result.start, &time_result.start);

    if date_result.end.is_some() || time_result.end.is_some() {
        let end_date = date_result.end.as_ref().unwrap_or(&date_result.start);
        let end_time = time_result.end.as_ref().unwrap_or(&time_result.start);
        let mut end_date_time = merge_date_time_component(end_date, end_time);

        let earlier = matches!(
            (end_date_time.date().get_time(), result.start.date().get_time()),
            (Some(e), Some(s)) if e < s
        );
        if date_result.end.is_none() && earlier {
            // For example, "Tuesday 9pm - 1am": the ending is 1am on the next day.
            let mut next_day = JsDate::from_millis(end_date_time.date().get_time().unwrap_or(0));
            next_day.set_date(next_day.get_date() + 1);
            if end_date_time.is_certain(Component::Day) {
                assign_similar_date(&mut end_date_time, next_day);
            } else {
                imply_similar_date(&mut end_date_time, next_day);
            }
        }
        result.end = Some(end_date_time);
    }
    result
}

/// `mergeDateTimeComponent(dateComponent, timeComponent)`.
pub fn merge_date_time_component(date: &ParsingComponents, time: &ParsingComponents) -> ParsingComponents {
    let mut dt = date.clone();
    // Upstream assigns/implies `time.get(...)` directly; every time component has these implied.
    let t = |c| time.get_or_zero(c);
    if time.is_certain(Component::Hour) {
        dt.assign(Component::Hour, t(Component::Hour));
        dt.assign(Component::Minute, t(Component::Minute));
        if time.is_certain(Component::Second) {
            dt.assign(Component::Second, t(Component::Second));
            if time.is_certain(Component::Millisecond) {
                dt.assign(Component::Millisecond, t(Component::Millisecond));
            } else {
                dt.imply(Component::Millisecond, t(Component::Millisecond));
            }
        } else {
            dt.imply(Component::Second, t(Component::Second));
            dt.imply(Component::Millisecond, t(Component::Millisecond));
        }
    } else {
        dt.imply(Component::Hour, t(Component::Hour));
        dt.imply(Component::Minute, t(Component::Minute));
        dt.imply(Component::Second, t(Component::Second));
        dt.imply(Component::Millisecond, t(Component::Millisecond));
    }

    if time.is_certain(Component::TimezoneOffset) {
        dt.assign(Component::TimezoneOffset, t(Component::TimezoneOffset));
    }

    let date_has_meaningful_meridiem = date.get(Component::Meridiem).is_some()
        && (date.is_certain(Component::Meridiem) || date.tags().iter().any(|t| t.starts_with("casualReference/")));

    if time.is_certain(Component::Meridiem) {
        dt.assign(Component::Meridiem, t(Component::Meridiem));
    } else if let Some(m) = time.get(Component::Meridiem) {
        if !date_has_meaningful_meridiem {
            // The time guides meridiem only when the date part carries no meaningful hint.
            dt.imply(Component::Meridiem, m);
        }
    }

    // JS `null < 12` is true, hence `get_or_zero`.
    if dt.get(Component::Meridiem) == Some(meridiem::PM) && dt.get_or_zero(Component::Hour) < 12 {
        let hour = dt.get_or_zero(Component::Hour) + 12;
        if time.is_certain(Component::Hour) {
            dt.assign(Component::Hour, hour);
        } else {
            dt.imply(Component::Hour, hour);
        }
    }

    let date_tags: Vec<String> = date.tags().to_vec();
    let time_tags: Vec<String> = time.tags().to_vec();
    dt.add_tags(date_tags.iter().map(String::as_str));
    dt.add_tags(time_tags.iter().map(String::as_str));
    dt
}
