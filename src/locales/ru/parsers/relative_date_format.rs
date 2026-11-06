//! upstream `locales/ru/parsers/RURelativeDateFormatParser.ts`.

use std::sync::LazyLock;

use crate::calculation::duration::Duration;
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::{Component, ParsingComponents};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::pattern::{dict_get, dict_keys, match_any_pattern};
use crate::locales::ru::abstract_parser_with_word_boundary_checking::{
    left_right_boundary_inner_pattern, pattern_left_boundary,
};
use crate::locales::ru::constants::TIME_UNIT_DICTIONARY;

pub const UPSTREAM: &str = "RURelativeDateFormatParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(RuRelativeDateFormatParser))
}

static PATTERN: LazyLock<JsRegex> = LazyLock::new(|| {
    left_right_boundary_inner_pattern(&format!(
        r"(в прошлом|на прошлой|на следующей|в следующем|на этой|в этом)\s*({})",
        match_any_pattern(dict_keys(TIME_UNIT_DICTIONARY))
    ))
});

const MODIFIER_WORD_GROUP: usize = 1;
const RELATIVE_WORD_GROUP: usize = 2;

struct RuRelativeDateFormatParser;

impl WordBoundaryParser for RuRelativeDateFormatParser {
    fn pattern_left_boundary(&self) -> &str {
        pattern_left_boundary()
    }

    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        PATTERN.clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let modifier = m.get(MODIFIER_WORD_GROUP).unwrap_or("").to_lowercase();
        let unit_word = m.get(RELATIVE_WORD_GROUP).unwrap_or("").to_lowercase();
        let Some(timeunit) = dict_get(TIME_UNIT_DICTIONARY, &unit_word) else {
            return Extracted::None;
        };

        if modifier == "на следующей" || modifier == "в следующем" {
            let mut units = Duration::from_pairs(&[(timeunit, 1.0)]);
            return Extracted::Components(ParsingComponents::create_relative_from_reference(
                context.reference,
                &mut units,
            ));
        }

        if modifier == "в прошлом" || modifier == "на прошлой" {
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
