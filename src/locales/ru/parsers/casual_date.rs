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
        // Upstream lowercases `match[1]`, the captured word, not the whole match ("с сегодня").
        let lower_text = m.get(1).unwrap_or("").to_lowercase();
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

#[cfg(test)]
mod tests {
    use crate::{JsDate, ParsingOption, ReferenceInput};

    /// Escaped defect (#397, golden `ru/casual#22`): with the optional "с"/"со" prefix the whole
    /// match was looked up, so the date fell through to empty components. Expected values are
    /// chrono-node's output (TZ=UTC).
    #[test]
    fn prefixed_casual_dates_resolve_from_the_captured_word() {
        let reference = ReferenceInput::Date(JsDate::parse_iso("2024-03-06T12:00:00.000Z").unwrap());
        let cases = [
            ("с сегодня", 0, "с сегодня", "2024-03-06T12:00:00.000Z"),
            ("со вчера", 0, "со вчера", "2024-03-05T12:00:00.000Z"),
            ("С ЗАВТРА", 0, "С ЗАВТРА", "2024-03-07T12:00:00.000Z"),
            ("Событие с послезавтра", 15, "с послезавтра", "2024-03-08T12:00:00.000Z"),
        ];
        for (text, index, matched, date) in cases {
            let results = crate::locales::ru::casual().parse(text, &reference, &ParsingOption::default());
            assert_eq!(results.len(), 1, "{text}");
            let r = &results[0];
            assert_eq!((r.index, r.text.as_str()), (index, matched), "{text}");
            assert_eq!(r.start.date().to_iso_string().unwrap(), date, "{text}");
        }
    }
}
