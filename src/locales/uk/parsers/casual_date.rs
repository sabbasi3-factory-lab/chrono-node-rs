//! upstream `locales/uk/parsers/UKCasualDateParser.ts`.

use crate::common::casual_references as references;
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::locales::uk::abstract_parser_with_word_boundary_checking::{
    left_right_boundary_inner_pattern, pattern_left_boundary,
};

pub const UPSTREAM: &str = "UKCasualDateParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(UkCasualDateParser))
}

struct UkCasualDateParser;

impl WordBoundaryParser for UkCasualDateParser {
    fn pattern_left_boundary(&self) -> &str {
        pattern_left_boundary()
    }

    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        left_right_boundary_inner_pattern(
            r"(?:з|із|від)?\s*(сьогодні|вчора|завтра|післязавтра|післяпіслязавтра|позапозавчора|позавчора)",
        )
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let lower_text = m.get(1).unwrap_or("").to_lowercase();
        let reference = context.reference;
        let component = match lower_text.as_str() {
            "сьогодні" => references::today(reference),
            "вчора" => references::yesterday(reference),
            "завтра" => references::tomorrow(reference),
            "післязавтра" => references::the_day_after(reference, 2),
            "післяпіслязавтра" => references::the_day_after(reference, 3),
            "позавчора" => references::the_day_before(reference, 2),
            "позапозавчора" => references::the_day_before(reference, 3),
            _ => context.create_parsing_components(&[]),
        };
        Extracted::Components(component)
    }
}
