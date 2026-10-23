//! upstream `locales/en/refiners/ENEndOfPeriodRefiner.ts`.
//!
//! Moves a result preceded by "end of" or "last day of" to the last day of its period.

use crate::calculation::years::find_year_closest_to_ref;
use crate::core::chrono::Refiner;
use crate::core::components::Component;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::js_date::JsDate;
use crate::core::result::ParsingResult;
use crate::js_regex;

pub const UPSTREAM: &str = "ENEndOfPeriodRefiner";

pub fn create(_flags: &Flags) -> Box<dyn Refiner> {
    Box::new(EnEndOfPeriodRefiner)
}

fn modifier_offset(modifier: &str) -> i64 {
    match modifier {
        "next" => 1,
        "last" | "past" => -1,
        _ => 0,
    }
}

struct EnEndOfPeriodRefiner;

impl Refiner for EnEndOfPeriodRefiner {
    fn refine(&self, context: &ParsingContext, mut results: Vec<ParsingResult>) -> Vec<ParsingResult> {
        for result in results.iter_mut() {
            let Some(prefix) = js_regex!(r"\b(?:last\s+day|end)\s+of\s+(?:the\s+)?$", "i")
                .exec(&context.text[..result.index])
            else {
                continue;
            };
            let prefix_text = prefix.text().to_string();

            if let Some(relative) = js_regex!(r"^(this|last|past|next)\s*(week|month|year)$", "i").exec(&result.text) {
                let modifier = relative.get(1).unwrap_or("").to_lowercase();
                let period = relative.get(2).unwrap_or("").to_lowercase();
                move_to_end_of_relative_period(context, result, &modifier, &period);
            } else if result.start.is_certain(Component::Month) && !result.start.is_certain(Component::Day) {
                move_to_end_of_month(context, result);
            } else {
                continue;
            }

            result.start.imply(Component::Hour, 12);
            result.start.imply(Component::Minute, 0);
            result.start.imply(Component::Second, 0);
            result.start.imply(Component::Millisecond, 0);
            if !result.start.is_certain(Component::TimezoneOffset) {
                result.start.delete(&[Component::TimezoneOffset]);
            }
            result.index -= prefix_text.len();
            result.text = format!("{}{}", prefix_text, result.text);
            result.add_tag("refiner/ENEndOfPeriodRefiner");
        }
        results
    }
}

fn move_to_end_of_relative_period(context: &ParsingContext, result: &mut ParsingResult, modifier: &str, period: &str) {
    let offset = modifier_offset(modifier);
    let reference_date = context.reference.get_date_with_adjusted_timezone();

    let last_day = if period == "week" {
        let mut d = reference_date;
        d.set_date(reference_date.get_date() + (6 - reference_date.get_day()) + offset * 7);
        d
    } else if period == "month" {
        JsDate::local(reference_date.get_full_year(), reference_date.get_month() + offset + 1, 0, 0, 0, 0, 0)
    } else {
        JsDate::local(reference_date.get_full_year() + offset, 11, 31, 0, 0, 0, 0)
    };

    result.start.assign(Component::Day, last_day.get_date());
    result.start.assign(Component::Month, last_day.get_month() + 1);
    result.start.assign(Component::Year, last_day.get_full_year());
    result.start.delete(&[Component::Weekday]);
    result.start.imply(Component::Weekday, last_day.get_day());
}

fn move_to_end_of_month(context: &ParsingContext, result: &mut ParsingResult) {
    let mut year = result.start.get_or_zero(Component::Year);
    let month = result.start.get_or_zero(Component::Month);
    let rest = &context.text[result.index + result.text.len()..];
    let last_day_of = |year: i64| JsDate::local(year, month, 0, 0, 0, 0, 0).get_date();

    if let Some(suffix) = js_regex!(r"^\s+(this|last|past|next)\s+year(?=\W|$)", "i").exec(rest) {
        let modifier = suffix.get(1).unwrap_or("").to_lowercase();
        let reference_year = context.reference.get_date_with_adjusted_timezone().get_full_year();
        year = reference_year + modifier_offset(&modifier);
        result.start.assign(Component::Year, year);
        result.text.push_str(suffix.text());
    }

    if !result.start.is_certain(Component::Year) {
        let last_day_in_reference_year = last_day_of(year);
        year = find_year_closest_to_ref(
            context.reference.get_date_with_adjusted_timezone(),
            last_day_in_reference_year,
            month,
        );
        result.start.imply(Component::Year, year);
    }

    result.start.assign(Component::Day, last_day_of(year));
}
