//! upstream `locales/zh/hant/parsers/ZHHantRelationWeekdayParser.ts`.

use std::sync::LazyLock;

use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::Component;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::pattern::{dict_get, dict_keys, match_any_pattern};
use crate::locales::zh_hant::constants::WEEKDAY_OFFSET;

pub const UPSTREAM: &str = "ZHHantRelationWeekdayParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(ZhHantRelationWeekdayParser))
}

static PATTERN: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(
        &format!(
            "(?<prefix>上|今|下|這|呢)(?:個)?(?:星期|禮拜|週)(?<weekday>{})",
            match_any_pattern(dict_keys(WEEKDAY_OFFSET))
        ),
        "",
    )
});

const PREFIX_GROUP: usize = 1;
const WEEKDAY_GROUP: usize = 2;

struct ZhHantRelationWeekdayParser;

impl WordBoundaryParser for ZhHantRelationWeekdayParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        PATTERN.clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let mut result = context.create_parsing_result(m.index, m.text(), None, None);

        let day_of_week = m.get(WEEKDAY_GROUP).unwrap_or("");
        let Some(offset) = dict_get(WEEKDAY_OFFSET, day_of_week) else {
            return Extracted::None;
        };

        let prefix = m.get(PREFIX_GROUP).unwrap_or("");
        let modifier = match prefix {
            "上" => Some("last"),
            "下" => Some("next"),
            "今" | "這" | "呢" => Some("this"),
            _ => None,
        };

        let mut date = context.ref_date;
        let mut start_moment_fixed = false;
        let ref_offset = date.get_day();

        match modifier {
            Some("last") | Some("past") => {
                date.set_date(date.get_date() + (offset - 7 - ref_offset));
                start_moment_fixed = true;
            }
            Some("next") => {
                date.set_date(date.get_date() + (offset + 7 - ref_offset));
                start_moment_fixed = true;
            }
            Some("this") => {
                date.set_date(date.get_date() + (offset - ref_offset));
            }
            _ => {
                let mut diff = offset - ref_offset;
                if (diff - 7).abs() < diff.abs() {
                    diff -= 7;
                }
                if (diff + 7).abs() < diff.abs() {
                    diff += 7;
                }
                date.set_date(date.get_date() + diff);
            }
        }

        result.start.assign(Component::Weekday, offset);
        if start_moment_fixed {
            result.start.assign(Component::Day, date.get_date());
            result.start.assign(Component::Month, date.get_month() + 1);
            result.start.assign(Component::Year, date.get_full_year());
        } else {
            result.start.imply(Component::Day, date.get_date());
            result.start.imply(Component::Month, date.get_month() + 1);
            result.start.imply(Component::Year, date.get_full_year());
        }

        Extracted::Result(result)
    }
}
