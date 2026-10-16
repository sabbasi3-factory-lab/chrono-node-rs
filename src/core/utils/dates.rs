//! upstream `utils/dates.ts`.

use crate::core::components::{meridiem, Component, ParsingComponents};
use crate::core::js_date::JsDate;

/// `assignSimilarDate(component, target)`.
pub fn assign_similar_date(component: &mut ParsingComponents, target: JsDate) {
    component.assign(Component::Day, target.get_date());
    component.assign(Component::Month, target.get_month() + 1);
    component.assign(Component::Year, target.get_full_year());
}

/// `assignSimilarTime(component, target)`.
pub fn assign_similar_time(component: &mut ParsingComponents, target: JsDate) {
    component.assign(Component::Hour, target.get_hours());
    component.assign(Component::Minute, target.get_minutes());
    component.assign(Component::Second, target.get_seconds());
    component.assign(Component::Millisecond, target.get_milliseconds());
    component.assign(
        Component::Meridiem,
        if target.get_hours() < 12 {
            meridiem::AM
        } else {
            meridiem::PM
        },
    );
}

/// `implySimilarDate(component, target)`.
pub fn imply_similar_date(component: &mut ParsingComponents, target: JsDate) {
    component.imply(Component::Day, target.get_date());
    component.imply(Component::Month, target.get_month() + 1);
    component.imply(Component::Year, target.get_full_year());
}

/// `implySimilarTime(component, target)`.
pub fn imply_similar_time(component: &mut ParsingComponents, target: JsDate) {
    component.imply(Component::Hour, target.get_hours());
    component.imply(Component::Minute, target.get_minutes());
    component.imply(Component::Second, target.get_seconds());
    component.imply(Component::Millisecond, target.get_milliseconds());
    component.imply(
        Component::Meridiem,
        if target.get_hours() < 12 {
            meridiem::AM
        } else {
            meridiem::PM
        },
    );
}
