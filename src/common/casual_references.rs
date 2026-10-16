//! upstream `common/casualReferences.ts`.

use crate::calculation::duration::{Duration, DurationUnit};
use crate::core::components::{meridiem, Component, ParsingComponents};
use crate::core::js_date::JsDate;
use crate::core::reference::ReferenceWithTimezone;
use crate::core::utils::dates::{assign_similar_date, assign_similar_time, imply_similar_time};

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

fn minus_one_day(date: JsDate) -> JsDate {
    date.get_time()
        .map_or(JsDate::INVALID, |t| JsDate::from_millis(t - DAY_MS))
}

pub fn now(reference: ReferenceWithTimezone) -> ParsingComponents {
    let target = reference.get_date_with_adjusted_timezone();
    let mut c = ParsingComponents::new(reference, &[]);
    assign_similar_date(&mut c, target);
    assign_similar_time(&mut c, target);
    c.assign(Component::TimezoneOffset, reference.get_timezone_offset());
    c.add_tag("casualReference/now");
    c
}

pub fn today(reference: ReferenceWithTimezone) -> ParsingComponents {
    let target = reference.get_date_with_adjusted_timezone();
    let mut c = ParsingComponents::new(reference, &[]);
    assign_similar_date(&mut c, target);
    imply_similar_time(&mut c, target);
    c.delete(&[Component::Meridiem]);
    c.add_tag("casualReference/today");
    c
}

pub fn yesterday(reference: ReferenceWithTimezone) -> ParsingComponents {
    let mut c = the_day_before(reference, 1);
    c.add_tag("casualReference/yesterday");
    c
}

pub fn tomorrow(reference: ReferenceWithTimezone) -> ParsingComponents {
    let mut c = the_day_after(reference, 1);
    c.add_tag("casualReference/tomorrow");
    c
}

pub fn the_day_before(reference: ReferenceWithTimezone, num_day: i64) -> ParsingComponents {
    the_day_after(reference, -num_day)
}

pub fn the_day_after(reference: ReferenceWithTimezone, n_days: i64) -> ParsingComponents {
    let target = reference.get_date_with_adjusted_timezone();
    let mut c = ParsingComponents::new(reference, &[]);
    let mut new_date = target;
    new_date.set_date(new_date.get_date() + n_days);
    assign_similar_date(&mut c, new_date);
    imply_similar_time(&mut c, new_date);
    c.delete(&[Component::Meridiem]);
    c
}

/// `tonight(reference, implyHour = 22)`.
pub fn tonight(reference: ReferenceWithTimezone, imply_hour: i64) -> ParsingComponents {
    let target = reference.get_date_with_adjusted_timezone();
    let mut c = ParsingComponents::new(reference, &[]);
    assign_similar_date(&mut c, target);
    c.imply(Component::Hour, imply_hour);
    c.imply(Component::Meridiem, meridiem::PM);
    c.add_tag("casualReference/tonight");
    c
}

/// `lastNight(reference, implyHour = 0)`.
pub fn last_night(reference: ReferenceWithTimezone, imply_hour: i64) -> ParsingComponents {
    let mut target = reference.get_date_with_adjusted_timezone();
    let mut c = ParsingComponents::new(reference, &[]);
    if target.get_hours() < 6 {
        target = minus_one_day(target);
    }
    assign_similar_date(&mut c, target);
    c.imply(Component::Hour, imply_hour);
    c
}

/// `evening(reference, implyHour = 20)`.
pub fn evening(reference: ReferenceWithTimezone, imply_hour: i64) -> ParsingComponents {
    let mut c = ParsingComponents::new(reference, &[]);
    c.imply(Component::Meridiem, meridiem::PM);
    c.imply(Component::Hour, imply_hour);
    c.add_tag("casualReference/evening");
    c
}

/// `yesterdayEvening(reference, implyHour = 20)`.
pub fn yesterday_evening(reference: ReferenceWithTimezone, imply_hour: i64) -> ParsingComponents {
    let target = minus_one_day(reference.get_date_with_adjusted_timezone());
    let mut c = ParsingComponents::new(reference, &[]);
    assign_similar_date(&mut c, target);
    c.imply(Component::Hour, imply_hour);
    c.imply(Component::Meridiem, meridiem::PM);
    c.add_tag("casualReference/yesterday");
    c.add_tag("casualReference/evening");
    c
}

pub fn midnight(reference: ReferenceWithTimezone) -> ParsingComponents {
    let mut c = ParsingComponents::new(reference, &[]);
    if reference.get_date_with_adjusted_timezone().get_hours() > 2 {
        // Unless it's very early morning (0~2AM), the midnight is the coming one.
        c.add_duration_as_implied(&mut Duration::from_pairs(&[(DurationUnit::Day, 1.0)]));
    }
    c.assign(Component::Hour, 0);
    c.imply(Component::Minute, 0);
    c.imply(Component::Second, 0);
    c.imply(Component::Millisecond, 0);
    c.add_tag("casualReference/midnight");
    c
}

/// `morning(reference, implyHour = 6)`.
pub fn morning(reference: ReferenceWithTimezone, imply_hour: i64) -> ParsingComponents {
    let mut c = ParsingComponents::new(reference, &[]);
    c.imply(Component::Meridiem, meridiem::AM);
    c.imply(Component::Hour, imply_hour);
    c.imply(Component::Minute, 0);
    c.imply(Component::Second, 0);
    c.imply(Component::Millisecond, 0);
    c.add_tag("casualReference/morning");
    c
}

/// `afternoon(reference, implyHour = 15)`.
pub fn afternoon(reference: ReferenceWithTimezone, imply_hour: i64) -> ParsingComponents {
    let mut c = ParsingComponents::new(reference, &[]);
    c.imply(Component::Meridiem, meridiem::PM);
    c.imply(Component::Hour, imply_hour);
    c.imply(Component::Minute, 0);
    c.imply(Component::Second, 0);
    c.imply(Component::Millisecond, 0);
    c.add_tag("casualReference/afternoon");
    c
}

pub fn noon(reference: ReferenceWithTimezone) -> ParsingComponents {
    let mut c = ParsingComponents::new(reference, &[]);
    c.imply(Component::Meridiem, meridiem::AM);
    c.assign(Component::Hour, 12);
    c.imply(Component::Minute, 0);
    c.imply(Component::Second, 0);
    c.imply(Component::Millisecond, 0);
    c.add_tag("casualReference/noon");
    c
}
