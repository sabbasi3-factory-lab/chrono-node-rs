//! upstream `locales/nl/parsers/NLRelativeDateFormatParser.ts`.

use std::sync::LazyLock;

use crate::calculation::duration::Duration;
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::{Component, ParsingComponents};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::pattern::{dict_get, dict_keys, match_any_pattern};
use crate::locales::nl::constants::TIME_UNIT_DICTIONARY;

pub const UPSTREAM: &str = "NLRelativeDateFormatParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(NlRelativeDateFormatParser))
}

static PATTERN: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(
        &format!(
            r"(dit|deze|(?:aan)?komend|volgend|afgelopen|vorig)e?\s*({})(?=\s*)(?=\W|$)",
            match_any_pattern(dict_keys(TIME_UNIT_DICTIONARY))
        ),
        "i",
    )
});

const MODIFIER_WORD_GROUP: usize = 1;
const RELATIVE_WORD_GROUP: usize = 2;

struct NlRelativeDateFormatParser;

impl WordBoundaryParser for NlRelativeDateFormatParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        PATTERN.clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let modifier = m.get(MODIFIER_WORD_GROUP).unwrap_or("").to_lowercase();
        let unit_word = m.get(RELATIVE_WORD_GROUP).unwrap_or("").to_lowercase();
        let Some(timeunit) = dict_get(TIME_UNIT_DICTIONARY, &unit_word) else {
            return Extracted::None;
        };

        if modifier == "volgend" || modifier == "komend" || modifier == "aankomend" {
            let mut units = Duration::from_pairs(&[(timeunit, 1.0)]);
            return Extracted::Components(ParsingComponents::create_relative_from_reference(
                context.reference,
                &mut units,
            ));
        }

        if modifier == "afgelopen" || modifier == "vorig" {
            let mut units = Duration::from_pairs(&[(timeunit, -1.0)]);
            return Extracted::Components(ParsingComponents::create_relative_from_reference(
                context.reference,
                &mut units,
            ));
        }

        let mut components = context.create_parsing_components(&[]);
        let mut date = context.reference.instant;

        if unit_word.contains("week") {
            date.set_date(date.get_date() - date.get_day());
            components.imply(Component::Day, date.get_date());
            components.imply(Component::Month, date.get_month() + 1);
            components.imply(Component::Year, date.get_full_year());
        } else if unit_word.contains("maand") {
            date.set_date(1);
            components.imply(Component::Day, date.get_date());
            components.assign(Component::Year, date.get_full_year());
            components.assign(Component::Month, date.get_month() + 1);
        } else if unit_word.contains("jaar") {
            date.set_date(1);
            date.set_month(0);
            components.imply(Component::Day, date.get_date());
            components.imply(Component::Month, date.get_month() + 1);
            components.assign(Component::Year, date.get_full_year());
        }

        Extracted::Components(components)
    }
}
