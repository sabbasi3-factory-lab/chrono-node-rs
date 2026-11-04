//! upstream `locales/ja/parsers/JPCasualDateParser.ts`.

use crate::common::casual_references as references;
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::{meridiem, Component};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::js_regex;

pub const UPSTREAM: &str = "JPCasualDateParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(JpCasualDateParser)
}

const PATTERN: &str =
    r"今日|きょう|本日|ほんじつ|昨日|きのう|明日|あした|今夜|こんや|今夕|こんゆう|今晩|こんばん|今朝|けさ";

fn normalize_text_to_kanji(text: &str) -> &str {
    match text {
        "きょう" => "今日",
        "ほんじつ" => "本日",
        "きのう" => "昨日",
        "あした" => "明日",
        "こんや" => "今夜",
        "こんゆう" => "今夕",
        "こんばん" => "今晩",
        "けさ" => "今朝",
        _ => text,
    }
}

struct JpCasualDateParser;

impl Parser for JpCasualDateParser {
    fn pattern(&self, _context: &ParsingContext) -> JsRegex {
        js_regex!(PATTERN, "i").clone()
    }

    fn extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let text = normalize_text_to_kanji(m.text());

        let mut components = context.create_parsing_components(&[]);

        match text {
            "昨日" => return Extracted::Components(references::yesterday(context.reference)),
            "明日" => return Extracted::Components(references::tomorrow(context.reference)),
            "本日" | "今日" => return Extracted::Components(references::today(context.reference)),
            _ => {}
        }

        if text == "今夜" || text == "今夕" || text == "今晩" {
            components.imply(Component::Hour, 22);
            components.assign(Component::Meridiem, meridiem::PM);
        } else if text.contains("今朝") {
            components.imply(Component::Hour, 6);
            components.assign(Component::Meridiem, meridiem::AM);
        }

        let date = context.ref_date;
        components.assign(Component::Day, date.get_date());
        components.assign(Component::Month, date.get_month() + 1);
        components.assign(Component::Year, date.get_full_year());
        Extracted::Components(components)
    }
}
