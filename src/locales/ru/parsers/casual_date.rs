//! upstream `locales/ru/parsers/RUCasualDateParser.ts`.

use crate::common::casual_references as references;
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::locales::ru::abstract_parser_with_word_boundary_checking::{
    left_right_boundary_inner_pattern, pattern_left_boundary,
};

pub const UPSTREAM: &str = "RUCasualDateParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(RuCasualDateParser))
}

struct RuCasualDateParser;

impl WordBoundaryParser for RuCasualDateParser {
    fn pattern_left_boundary(&self) -> &str {
        pattern_left_boundary()
    }

    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        left_right_boundary_inner_pattern(
            r"(?:с|со)?\s*(сегодня|вчера|завтра|послезавтра|послепослезавтра|позапозавчера|позавчера)",
        )
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let lower_text = m.text().to_lowercase();
        let reference = context.reference;

        let component = match lower_text.as_str() {
            "сегодня" => references::today(reference),
            "вчера" => references::yesterday(reference),
            "завтра" => references::tomorrow(reference),
            "послезавтра" => references::the_day_after(reference, 2),
            "послепослезавтра" => references::the_day_after(reference, 3),
            "позавчера" => references::the_day_before(reference, 2),
            "позапозавчера" => references::the_day_before(reference, 3),
            _ => context.create_parsing_components(&[]),
        };
        Extracted::Components(component)
    }
}
