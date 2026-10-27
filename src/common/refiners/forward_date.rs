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

#[cfg(test)]
mod tests {
    use crate::core::context::ParsingOption;
    use crate::core::js_date::JsDate;
    use crate::locales::en::configuration::create_casual_configuration;

    const REF: &str = "2012-08-10T12:00:00Z";

    fn run(text: &str, reference: &str, forward: bool) -> Vec<Option<i64>> {
        let chrono = create_casual_configuration(false).build();
        let reference = JsDate::parse_iso(reference).unwrap();
        let option = ParsingOption {
            forward_date: forward,
            ..Default::default()
        };
        chrono
            .parse(text, &reference.into(), &option)
            .iter()
            .flat_map(|r| {
                let mut v = vec![r.start.date().get_time()];
                if let Some(e) = &r.end {
                    v.push(e.date().get_time());
                }
                v
            })
            .collect()
    }

    fn check(text: &str, reference: &str, off: &[i64], on: &[i64]) {
        let wrap = |v: &[i64]| v.iter().map(|x| Some(*x)).collect::<Vec<_>>();
        assert_eq!(run(text, reference, false), wrap(off), "{text} without forwardDate");
        assert_eq!(run(text, reference, true), wrap(on), "{text} with forwardDate");
    }

    #[test]
    fn only_time() {
        check("at 10am", REF, &[1344592800000], &[1344679200000]);
        check("at 1pm", REF, &[1344603600000], &[1344603600000]);
    }

    #[test]
    fn only_time_range() {
        check("from 10am to 8am", REF, &[1344592800000, 1344672000000], &[1344679200000, 1344758400000]);
        check("from 9am to 11am", REF, &[1344589200000, 1344596400000], &[1344675600000, 1344682800000]);
        check(
            "from 10pm to 8am",
            "2012-08-10T23:00:00Z",
            &[1344636000000, 1344672000000],
            &[1344722400000, 1344758400000],
        );
    }

    #[test]
    fn weekday() {
        check("Thursday", REF, &[1344513600000], &[1345118400000]);
        check("Friday", REF, &[1344600000000], &[1344600000000]);
        check("Monday", REF, &[1344859200000], &[1344859200000]);
    }

    #[test]
    fn weekday_range() {
        check("Thursday - Friday", REF, &[1344513600000, 1344600000000], &[1345118400000, 1345204800000]);
        check("Monday - Wednesday", REF, &[1344859200000, 1345032000000], &[1344859200000, 1345032000000]);
    }

    #[test]
    fn unknown_year() {
        check("Jan 5", REF, &[1357387200000], &[1357387200000]);
        check("Aug 1 - Sep 3", REF, &[1343822400000, 1346673600000], &[1375358400000, 1378209600000]);
        check("Aug 10 2011", REF, &[1312977600000], &[1312977600000]);
    }
}
