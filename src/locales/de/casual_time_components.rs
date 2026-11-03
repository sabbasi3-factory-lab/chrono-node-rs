//! upstream `locales/de/parsers/DECasualTimeParser.ts`: the static `extractTimeComponents`.
//!
//! Both `DECasualTimeParser` and `DECasualDateParser` call it, so it's ported by hand here and the
//! two parser tasks don't share a file.

use crate::calculation::duration::{Duration, DurationUnit};
use crate::core::components::{meridiem, Component, ParsingComponents};

fn imply_time(component: &mut ParsingComponents, hour: i64, meridiem: i64) {
    component.imply(Component::Hour, hour);
    component.imply(Component::Minute, 0);
    component.imply(Component::Second, 0);
    component.imply(Component::Meridiem, meridiem);
}

/// `DECasualTimeParser.extractTimeComponents(component, timeKeywordPattern)`.
///
/// `time_keyword_pattern` is already lower-cased by the callers, as upstream does. Unknown
/// keywords leave the component unchanged.
pub fn extract_time_components(component: &mut ParsingComponents, time_keyword_pattern: &str) {
    match time_keyword_pattern {
        "morgen" => {
            imply_time(component, 6, meridiem::AM);
            component.add_tag("casualReference/morning");
        }
        "vormittag" => {
            imply_time(component, 9, meridiem::AM);
            component.add_tag("casualReference/morning");
        }
        "mittag" | "mittags" => {
            imply_time(component, 12, meridiem::AM);
            component.add_tag("casualReference/noon");
        }
        "nachmittag" => {
            imply_time(component, 15, meridiem::PM);
            component.add_tag("casualReference/afternoon");
        }
        "abend" => {
            imply_time(component, 18, meridiem::PM);
            component.add_tag("casualReference/evening");
        }
        "nacht" => {
            imply_time(component, 22, meridiem::PM);
            component.add_tag("casualReference/evening");
        }
        "mitternacht" => {
            // `component.get("hour") > 1`: false for null.
            if component.get(Component::Hour).is_some_and(|h| h > 1) {
                component.add_duration_as_implied(&mut Duration::from_pairs(&[(DurationUnit::Day, 1.0)]));
            }
            imply_time(component, 0, meridiem::AM);
            component.add_tag("casualReference/midnight");
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    //! Expected values were produced by chrono-node v2.10.3 (compiled from `upstream/`).
    use super::*;
    use crate::core::js_date::JsDate;
    use crate::core::reference::ReferenceWithTimezone;
    use crate::core::utils::dates::imply_similar_time;

    fn at(hour: i64) -> ParsingComponents {
        // 2012-08-10T<hour>:30:00Z, like `implySimilarTime(component, refDate)` in the parser.
        let date = JsDate::from_millis(1_344_556_800_000 + hour * 3_600_000 + 30 * 60_000);
        let mut c = ParsingComponents::new(ReferenceWithTimezone::new(date, None), &[]);
        imply_similar_time(&mut c, date);
        c
    }

    type Summary = (Option<i64>, Option<i64>, Option<i64>, Option<i64>, Vec<String>);

    fn summary(c: &ParsingComponents) -> Summary {
        (
            c.get(Component::Day),
            c.get(Component::Hour),
            c.get(Component::Minute),
            c.get(Component::Meridiem),
            c.tags().to_vec(),
        )
    }

    #[test]
    fn keywords() {
        for (keyword, hour, meridiem, tag) in [
            ("morgen", 6, 0, "casualReference/morning"),
            ("vormittag", 9, 0, "casualReference/morning"),
            ("mittag", 12, 0, "casualReference/noon"),
            ("mittags", 12, 0, "casualReference/noon"),
            ("nachmittag", 15, 1, "casualReference/afternoon"),
            ("abend", 18, 1, "casualReference/evening"),
            ("nacht", 22, 1, "casualReference/evening"),
        ] {
            let mut c = at(8);
            extract_time_components(&mut c, keyword);
            assert_eq!(
                summary(&c),
                (Some(10), Some(hour), Some(0), Some(meridiem), vec![tag.to_string()]),
                "{keyword}"
            );
        }
    }

    #[test]
    fn midnight_moves_to_the_next_day_after_1am() {
        let mut c = at(8);
        extract_time_components(&mut c, "mitternacht");
        assert_eq!(
            summary(&c),
            (
                Some(11),
                Some(0),
                Some(0),
                Some(0),
                vec!["casualReference/midnight".to_string()]
            )
        );
        let mut c = at(1);
        extract_time_components(&mut c, "mitternacht");
        assert_eq!(
            summary(&c),
            (
                Some(10),
                Some(0),
                Some(0),
                Some(0),
                vec!["casualReference/midnight".to_string()]
            )
        );
    }

    #[test]
    fn unknown_keyword_changes_nothing() {
        let mut c = at(8);
        extract_time_components(&mut c, "MORGEN");
        assert_eq!(summary(&c), (Some(10), Some(8), Some(30), Some(0), vec![]));
    }
}
