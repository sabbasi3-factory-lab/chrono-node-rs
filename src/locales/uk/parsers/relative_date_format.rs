//! upstream `locales/uk/parsers/UKRelativeDateFormatParser.ts`.

use crate::calculation::duration::Duration;
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::{Component, ParsingComponents};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::pattern::{dict_get, dict_keys, match_any_pattern};
use crate::locales::uk::abstract_parser_with_word_boundary_checking::{
    left_right_boundary_inner_pattern, pattern_left_boundary,
};
use crate::locales::uk::constants::TIME_UNIT_DICTIONARY;

pub const UPSTREAM: &str = "UKRelativeDateFormatParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(UkRelativeDateFormatParser))
}

const MODIFIER_WORD_GROUP: usize = 1;
const RELATIVE_WORD_GROUP: usize = 2;

struct UkRelativeDateFormatParser;

impl WordBoundaryParser for UkRelativeDateFormatParser {
    fn pattern_left_boundary(&self) -> &str {
        pattern_left_boundary()
    }

    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        left_right_boundary_inner_pattern(&format!(
            r"(в минулому|у минулому|на минулому|минулого|на наступному|в наступному|у наступному|наступного|на цьому|в цьому|у цьому|цього)\s*({})(?=\s*)",
            match_any_pattern(dict_keys(TIME_UNIT_DICTIONARY))
        ))
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let modifier = m.get(MODIFIER_WORD_GROUP).unwrap_or("").to_lowercase();
        let unit_word = m.get(RELATIVE_WORD_GROUP).unwrap_or("").to_lowercase();
        let Some(timeunit) = dict_get(TIME_UNIT_DICTIONARY, &unit_word) else {
            return Extracted::None;
        };

        if matches!(
            modifier.as_str(),
            "на наступному" | "в наступному" | "у наступному" | "наступного"
        ) {
            let mut units = Duration::from_pairs(&[(timeunit, 1.0)]);
            return Extracted::Components(ParsingComponents::create_relative_from_reference(
                context.reference,
                &mut units,
            ));
        }

        if matches!(
            modifier.as_str(),
            "на минулому" | "в минулому" | "у минулому" | "минулого"
        ) {
            let mut units = Duration::from_pairs(&[(timeunit, -1.0)]);
            return Extracted::Components(ParsingComponents::create_relative_from_reference(
                context.reference,
                &mut units,
            ));
        }

        let mut components = context.create_parsing_components(&[]);
        let mut date = context.reference.instant;
        let key = timeunit.key().to_lowercase();

        if key.contains("week") {
            date.set_date(date.get_date() - date.get_day());
            components.imply(Component::Day, date.get_date());
            components.imply(Component::Month, date.get_month() + 1);
            components.imply(Component::Year, date.get_full_year());
        } else if key.contains("month") {
            date.set_date(1);
            components.imply(Component::Day, date.get_date());
            components.assign(Component::Year, date.get_full_year());
            components.assign(Component::Month, date.get_month() + 1);
        } else if key.contains("year") {
            date.set_date(1);
            date.set_month(0);
            components.imply(Component::Day, date.get_date());
            components.imply(Component::Month, date.get_month() + 1);
            components.assign(Component::Year, date.get_full_year());
        }

        Extracted::Components(components)
    }
}
