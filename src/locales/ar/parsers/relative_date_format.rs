//! upstream `locales/ar/parsers/ARRelativeDateFormatParser.ts`.

use crate::calculation::duration::{Duration, DurationUnit};
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::{Component, ParsingComponents};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::locales::ar::abstract_parser_with_word_boundary_checking::{
    left_right_boundary_inner_pattern, pattern_left_boundary,
};

pub const UPSTREAM: &str = "ARRelativeDateFormatParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(ArRelativeDateFormatParser))
}

const PREFIX_GROUP: usize = 1;
const UNIT_GROUP: usize = 2;
const POSTFIX_GROUP: usize = 3;

struct ArRelativeDateFormatParser;

impl WordBoundaryParser for ArRelativeDateFormatParser {
    fn pattern_left_boundary(&self) -> &str {
        pattern_left_boundary()
    }

    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        left_right_boundary_inner_pattern(concat!(
            r"(?:في\s+)?",
            r"(?:(هذا|هذه)\s+)?",
            r"(الشهر|الاسبوع|الأسبوع|العام|السنة)",
            r"(?:\s+(الماضي|الماضية|السابق|السابقة|المنصرم|المنصرمة|القادم|القادمة|المقبل|المقبلة|التالي|التالية))?",
        ))
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let _prefix = m.get(PREFIX_GROUP).unwrap_or("").to_lowercase();
        let unit_word = m.get(UNIT_GROUP).unwrap_or("").to_lowercase();
        let postfix = m.get(POSTFIX_GROUP).unwrap_or("").to_lowercase();

        let timeunit = match unit_word.as_str() {
            "الاسبوع" | "الأسبوع" => DurationUnit::Week,
            "العام" | "السنة" => DurationUnit::Year,
            _ => DurationUnit::Month,
        };

        let step = match postfix.as_str() {
            "القادم" | "القادمة" | "المقبل" | "المقبلة" | "التالي" | "التالية" => Some(1.0),
            "الماضي" | "الماضية" | "السابق" | "السابقة" | "المنصرم" | "المنصرمة" => Some(-1.0),
            _ => None,
        };
        if let Some(step) = step {
            let mut units = Duration::from_pairs(&[(timeunit, step)]);
            return Extracted::Components(ParsingComponents::create_relative_from_reference(
                context.reference,
                &mut units,
            ));
        }

        let mut components = context.create_parsing_components(&[]);
        let mut date = context.reference.instant;

        match timeunit {
            DurationUnit::Week => {
                date.set_date(date.get_date() - date.get_day());
                components.imply(Component::Day, date.get_date());
                components.imply(Component::Month, date.get_month() + 1);
                components.imply(Component::Year, date.get_full_year());
            }
            DurationUnit::Month => {
                date.set_date(1);
                components.imply(Component::Day, date.get_date());
                components.assign(Component::Year, date.get_full_year());
                components.assign(Component::Month, date.get_month() + 1);
            }
            _ => {
                date.set_date(1);
                date.set_month(0);
                components.imply(Component::Day, date.get_date());
                components.imply(Component::Month, date.get_month() + 1);
                components.assign(Component::Year, date.get_full_year());
            }
        }

        Extracted::Components(components)
    }
}
