//! upstream `locales/id/parsers/IDRelativeDateFormatParser.ts`.

use std::sync::LazyLock;

use crate::calculation::duration::{Duration, DurationUnit};
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::{Component, ParsingComponents};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::js::is_js_whitespace;

pub const UPSTREAM: &str = "IDRelativeDateFormatParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(IdRelativeDateFormatParser))
}

static PATTERN: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(
        r"(minggu|pekan|bulan|tahun)\s+(ini|depan|berikutnya|mendatang|yang\s+lalu|lalu|kemarin)(?=\W|$)",
        "i",
    )
});

const UNIT_WORD_GROUP: usize = 1;
const MODIFIER_WORD_GROUP: usize = 2;

const UNIT_WORD_TO_TIMEUNIT: &[(&str, DurationUnit)] = &[
    ("minggu", DurationUnit::Week),
    ("pekan", DurationUnit::Week),
    ("bulan", DurationUnit::Month),
    ("tahun", DurationUnit::Year),
];

struct IdRelativeDateFormatParser;

/// `.replace(/\s+/g, " ")`
fn collapse_whitespace(s: &str) -> String {
    let mut out = String::new();
    let mut in_ws = false;
    for c in s.chars() {
        if is_js_whitespace(c) {
            if !in_ws {
                out.push(' ');
            }
            in_ws = true;
        } else {
            out.push(c);
            in_ws = false;
        }
    }
    out
}

impl WordBoundaryParser for IdRelativeDateFormatParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        PATTERN.clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let unit_word = m.get(UNIT_WORD_GROUP).unwrap_or("").to_lowercase();
        let modifier = collapse_whitespace(&m.get(MODIFIER_WORD_GROUP).unwrap_or("").to_lowercase());
        let Some(&(_, timeunit)) = UNIT_WORD_TO_TIMEUNIT.iter().find(|(k, _)| *k == unit_word)
        else {
            return Extracted::None;
        };

        if modifier == "depan" || modifier == "berikutnya" || modifier == "mendatang" {
            let mut units = Duration::from_pairs(&[(timeunit, 1.0)]);
            return Extracted::Components(ParsingComponents::create_relative_from_reference(
                context.reference,
                &mut units,
            ));
        }

        if modifier == "lalu" || modifier == "yang lalu" || modifier == "kemarin" {
            let mut units = Duration::from_pairs(&[(timeunit, -1.0)]);
            return Extracted::Components(ParsingComponents::create_relative_from_reference(
                context.reference,
                &mut units,
            ));
        }

        let mut components = context.create_parsing_components(&[]);
        let mut date = context.reference.instant;

        if timeunit == DurationUnit::Week {
            date.set_date(date.get_date() - date.get_day());
            components.imply(Component::Day, date.get_date());
            components.imply(Component::Month, date.get_month() + 1);
            components.imply(Component::Year, date.get_full_year());
        } else if timeunit == DurationUnit::Month {
            date.set_date(1);
            components.imply(Component::Day, date.get_date());
            components.assign(Component::Year, date.get_full_year());
            components.assign(Component::Month, date.get_month() + 1);
        } else if timeunit == DurationUnit::Year {
            date.set_date(1);
            date.set_month(0);
            components.imply(Component::Day, date.get_date());
            components.imply(Component::Month, date.get_month() + 1);
            components.assign(Component::Year, date.get_full_year());
        }

        Extracted::Components(components)
    }
}
