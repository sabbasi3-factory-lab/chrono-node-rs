//! upstream `common/refiners/ForwardDateRefiner.ts`.

use crate::calculation::duration::{add_duration, Duration, DurationUnit};
use crate::calculation::weekdays::get_days_forward_to_weekday;
use crate::core::chrono::Refiner;
use crate::core::components::Component;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::js_date::JsDate;
use crate::core::result::ParsingResult;
use crate::core::utils::dates::imply_similar_date;

pub const UPSTREAM: &str = "ForwardDateRefiner";

pub fn create(_flags: &Flags) -> Box<dyn Refiner> {
    Box::new(ForwardDateRefiner)
}

/// upstream `ForwardDateRefiner`.
pub struct ForwardDateRefiner;

/// JS `a > b` on dates: false when either is an invalid date (`NaN`).
fn gt(a: JsDate, b: JsDate) -> bool {
    matches!((a.get_time(), b.get_time()), (Some(x), Some(y)) if x > y)
}

fn forwarded_weekday(ref_date: JsDate, weekday: i64) -> JsDate {
    let mut days_to_add = get_days_forward_to_weekday(ref_date, weekday);
    if days_to_add == 0 {
        days_to_add = 7;
    }
    add_duration(ref_date, &mut Duration::from_pairs(&[(DurationUnit::Day, days_to_add as f64)]))
}

impl Refiner for ForwardDateRefiner {
    fn refine(&self, context: &ParsingContext, mut results: Vec<ParsingResult>) -> Vec<ParsingResult> {
        if !context.option.forward_date {
            return results;
        }

        for result in results.iter_mut() {
            let ref_date = context.reference.get_date_with_adjusted_timezone();

            if result.start.is_only_time() && gt(context.reference.instant, result.start.date()) {
                let mut ref_following_day = ref_date;
                ref_following_day.set_date(ref_following_day.get_date() + 1);

                imply_similar_date(&mut result.start, ref_following_day);
                if let Some(end) = result.end.as_mut() {
                    if end.is_only_time() {
                        imply_similar_date(end, ref_following_day);
                        if gt(result.start.date(), end.date()) {
                            ref_following_day.set_date(ref_following_day.get_date() + 1);
                            imply_similar_date(end, ref_following_day);
                        }
                    }
                }
            }

            if result.start.is_only_weekday_component() && gt(ref_date, result.start.date()) {
                let weekday = result.start.get_or_zero(Component::Weekday);
                let forwarded = forwarded_weekday(ref_date, weekday);
                imply_similar_date(&mut result.start, forwarded);

                if let Some(end) = result.end.as_mut() {
                    if gt(result.start.date(), end.date()) {
                        let weekday = result.start.get_or_zero(Component::Weekday);
                        let forwarded = forwarded_weekday(ref_date, weekday);
                        imply_similar_date(end, forwarded);
                    }
                }
            }

            if result.start.is_date_with_unknown_year() && gt(ref_date, result.start.date()) {
                let mut i = 0;
                while i < 3 && gt(ref_date, result.start.date()) {
                    let year = result.start.get_or_zero(Component::Year);
                    result.start.imply(Component::Year, year + 1);

                    if let Some(end) = result.end.as_mut() {
                        if !end.is_certain(Component::Year) {
                            let year = end.get_or_zero(Component::Year);
                            end.imply(Component::Year, year + 1);
                        }
                    }
                    i += 1;
                }
            }
        }

        results
    }
}
