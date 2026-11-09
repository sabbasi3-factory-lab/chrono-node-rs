//! upstream `locales/zh/hans/parsers/ZHHansDeadlineFormatParser.ts`.

use std::sync::LazyLock;

use super::super::constants::{zh_string_to_number, NUMBER};
use crate::calculation::duration::{add_duration, Duration, DurationUnit};
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::Component;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::js::js_parse_int;

pub const UPSTREAM: &str = "ZHHansDeadlineFormatParser";

const NUMBER_GROUP: usize = 1;
const UNIT_GROUP: usize = 2;

static PATTERN: LazyLock<JsRegex> = LazyLock::new(|| {
    let keys: String = NUMBER.iter().map(|(k, _)| *k).collect();
    JsRegex::new(
        &format!(
            r"(\d+|[{}]+|半|几)(?:\s*)(?:个)?(秒(?:钟)?|分钟|小时|钟|日|天|星期|礼拜|月|年)(?:(?:之|过)?后|(?:之)?内)",
            keys
        ),
        "i",
    )
});

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(ZhHansDeadlineFormatParser))
}

struct ZhHansDeadlineFormatParser;

impl WordBoundaryParser for ZhHansDeadlineFormatParser {
    fn pattern_left_boundary(&self) -> &str {
        "()"
    }

    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        PATTERN.clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let mut result = context.create_parsing_result(m.index, m.text(), None, None);

        let number_text = m.get(NUMBER_GROUP).unwrap_or("");
        let number: f64 = match js_parse_int(number_text).or_else(|| zh_string_to_number(number_text)) {
            Some(n) => n as f64,
            None => match number_text {
                "几" => 3.0,
                "半" => 0.5,
                _ => return Extracted::None,
            },
        };

        let mut duration = Duration::new();
        let unit = m.get(UNIT_GROUP).unwrap_or("");
        let unit_abbr = unit.chars().next().unwrap_or('\0');

        if "日天星礼月年".contains(unit_abbr) {
            match unit_abbr {
                '日' | '天' => duration.set(DurationUnit::Day, number),
                '星' | '礼' => duration.set(DurationUnit::Week, number),
                '月' => duration.set(DurationUnit::Month, number),
                '年' => duration.set(DurationUnit::Year, number),
                _ => {}
            }

            let date = add_duration(context.ref_date, &mut duration);
            result.start.assign(Component::Year, date.get_full_year());
            result.start.assign(Component::Month, date.get_month() + 1);
            result.start.assign(Component::Day, date.get_date());
            return Extracted::Result(result);
        }

        match unit_abbr {
            '秒' => duration.set(DurationUnit::Second, number),
            '分' => duration.set(DurationUnit::Minute, number),
            '小' | '钟' => duration.set(DurationUnit::Hour, number),
            _ => {}
        }

        let date = add_duration(context.ref_date, &mut duration);
        result.start.imply(Component::Year, date.get_full_year());
        result.start.imply(Component::Month, date.get_month() + 1);
        result.start.imply(Component::Day, date.get_date());
        result.start.assign(Component::Hour, date.get_hours());
        result.start.assign(Component::Minute, date.get_minutes());
        result.start.assign(Component::Second, date.get_seconds());
        Extracted::Result(result)
    }
}
