//! upstream `calculation/weekdays.ts`.

use crate::calculation::duration::{Duration, DurationUnit};
use crate::core::components::{weekday, Component, ParsingComponents};
use crate::core::js_date::JsDate;
use crate::core::reference::ReferenceWithTimezone;

/// The `"this" | "next" | "last"` modifier word.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WeekdayModifier {
    This,
    Next,
    Last,
}

/// `createParsingComponentsAtWeekday(reference, weekday, modifier)`.
pub fn create_parsing_components_at_weekday(
    reference: ReferenceWithTimezone,
    weekday: i64,
    modifier: Option<WeekdayModifier>,
) -> ParsingComponents {
    let ref_date = reference.get_date_with_adjusted_timezone();
    let days_to_weekday = get_days_to_weekday(ref_date, weekday, modifier);

    let mut components = ParsingComponents::new(reference, &[]);
    components.add_duration_as_implied(&mut Duration::from_pairs(&[(
        DurationUnit::Day,
        days_to_weekday as f64,
    )]));
    components.assign(Component::Weekday, weekday);
    components
}

/// `getDaysToWeekday(refDate, weekday, modifier)`.
pub fn get_days_to_weekday(ref_date: JsDate, weekday: i64, modifier: Option<WeekdayModifier>) -> i64 {
    let ref_weekday = ref_date.get_day();
    match modifier {
        Some(WeekdayModifier::This) => get_days_forward_to_weekday(ref_date, weekday),
        Some(WeekdayModifier::Last) => get_backward_days_to_weekday(ref_date, weekday),
        Some(WeekdayModifier::Next) => {
            // From Sunday, the next Sunday is 7 days later.
            if ref_weekday == weekday::SUNDAY {
                return if weekday == weekday::SUNDAY { 7 } else { weekday };
            }
            // From Saturday, the next Saturday is 7 days later, the next Sunday is 8 days later.
            if ref_weekday == weekday::SATURDAY {
                if weekday == weekday::SATURDAY {
                    return 7;
                }
                if weekday == weekday::SUNDAY {
                    return 8;
                }
                return 1 + weekday;
            }
            // From weekdays: if the weekday already passed this week, count forward to it;
            // otherwise count forward within this week, then add another 7 days.
            if weekday < ref_weekday && weekday != weekday::SUNDAY {
                get_days_forward_to_weekday(ref_date, weekday)
            } else {
                get_days_forward_to_weekday(ref_date, weekday) + 7
            }
        }
        None => get_days_to_weekday_closest(ref_date, weekday),
    }
}

/// `getDaysToWeekdayClosest(refDate, weekday)`.
pub fn get_days_to_weekday_closest(ref_date: JsDate, weekday: i64) -> i64 {
    let backward = get_backward_days_to_weekday(ref_date, weekday);
    let forward = get_days_forward_to_weekday(ref_date, weekday);
    if forward < -backward {
        forward
    } else {
        backward
    }
}

/// `getDaysForwardToWeekday(refDate, weekday)`.
pub fn get_days_forward_to_weekday(ref_date: JsDate, weekday: i64) -> i64 {
    let mut forward = weekday - ref_date.get_day();
    if forward < 0 {
        forward += 7;
    }
    forward
}

/// `getBackwardDaysToWeekday(refDate, weekday)`.
pub fn get_backward_days_to_weekday(ref_date: JsDate, weekday: i64) -> i64 {
    let mut backward = weekday - ref_date.get_day();
    if backward >= 0 {
        backward -= 7;
    }
    backward
}

#[cfg(test)]
mod tests {
    use super::*;

    // 2012-08-09 is a Thursday.
    fn thu() -> JsDate {
        JsDate::parse_iso("2012-08-09T00:00:00.000Z").unwrap()
    }

    #[test]
    fn closest_and_modifiers() {
        assert_eq!(get_days_to_weekday(thu(), weekday::MONDAY, None), -3);
        assert_eq!(get_days_to_weekday(thu(), weekday::SUNDAY, None), 3);
        assert_eq!(get_days_to_weekday(thu(), weekday::THURSDAY, None), 0);
        assert_eq!(
            get_days_to_weekday(thu(), weekday::FRIDAY, Some(WeekdayModifier::Last)),
            -6
        );
        assert_eq!(
            get_days_to_weekday(thu(), weekday::FRIDAY, Some(WeekdayModifier::Next)),
            8
        );
        assert_eq!(
            get_days_to_weekday(thu(), weekday::MONDAY, Some(WeekdayModifier::Next)),
            4
        );
        assert_eq!(
            get_days_to_weekday(thu(), weekday::MONDAY, Some(WeekdayModifier::This)),
            4
        );
    }
}
