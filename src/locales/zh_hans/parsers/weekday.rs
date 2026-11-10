//! upstream `locales/zh/hans/parsers/ZHHansWeekdayParser.ts`.

use std::sync::LazyLock;

use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::Component;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::pattern::{dict_get, dict_keys};
use crate::locales::zh_hans::constants::WEEKDAY_OFFSET;

pub const UPSTREAM: &str = "ZHHansWeekdayParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(ZhHansWeekdayParser))
}

static PATTERN: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(
        &format!(
            "(?:星期|礼拜|周)(?<weekday>{})",
            dict_keys(WEEKDAY_OFFSET).collect::<Vec<_>>().join("|")
        ),
        "",
    )
});

struct ZhHansWeekdayParser;

impl WordBoundaryParser for ZhHansWeekdayParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        PATTERN.clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let mut result = context.create_parsing_result(m.index, m.text(), None, None);

        let day_of_week = m.get(1).unwrap_or("");
        let Some(offset) = dict_get(WEEKDAY_OFFSET, day_of_week) else {
            return Extracted::None;
        };

        let mut date = context.ref_date;
        let ref_offset = date.get_day();

        let mut diff = offset - ref_offset;
        if (diff - 7).abs() < diff.abs() {
            diff -= 7;
        }
        if (diff + 7).abs() < diff.abs() {
            diff += 7;
        }

        date.set_date(date.get_date() + diff);

        result.start.assign(Component::Weekday, offset);
        result.start.imply(Component::Day, date.get_date());
        result.start.imply(Component::Month, date.get_month() + 1);
        result.start.imply(Component::Year, date.get_full_year());

        Extracted::Result(result)
    }
}
