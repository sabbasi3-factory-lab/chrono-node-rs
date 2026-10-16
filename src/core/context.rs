//! upstream `ParsingContext` and `ParsingOption`.

use super::components::{Component, ParsingComponents};
use super::js_date::JsDate;
use super::reference::{ReferenceInput, ReferenceWithTimezone};
use super::result::ParsingResult;
use super::timezone::TimezoneAbbrMap;

/// upstream `ParsingOption` (without the `debug` handler).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ParsingOption {
    /// `forwardDate`: prefer dates after the reference.
    pub forward_date: bool,
    /// `timezones`: abbreviation overrides.
    pub timezones: TimezoneAbbrMap,
}

/// upstream `ParsingContext`.
#[derive(Clone, Debug)]
pub struct ParsingContext {
    pub text: String,
    pub option: ParsingOption,
    pub reference: ReferenceWithTimezone,
    /// Deprecated upstream alias of `reference.instant`; parsers still read it.
    pub ref_date: JsDate,
}

impl ParsingContext {
    /// `new ParsingContext(text, refDate, option)`. `now` stands in for `new Date()`.
    pub fn new(text: &str, reference: &ReferenceInput, option: ParsingOption, now: JsDate) -> ParsingContext {
        let reference = ReferenceWithTimezone::from_input(reference, &option.timezones, now);
        ParsingContext {
            text: text.to_string(),
            option,
            ref_date: reference.instant,
            reference,
        }
    }

    /// `createParsingComponents(components)`.
    pub fn create_parsing_components(&self, known: &[(Component, i64)]) -> ParsingComponents {
        ParsingComponents::new(self.reference, known)
    }

    /// `createParsingResult(index, text, start?, end?)`.
    pub fn create_parsing_result(
        &self,
        index: usize,
        text: impl Into<String>,
        start: Option<ParsingComponents>,
        end: Option<ParsingComponents>,
    ) -> ParsingResult {
        ParsingResult::new(self.reference, index, text, start, end)
    }

    /// `createParsingResult(index, endIndex, ...)`: the text is `context.text.substring(index, endIndex)`.
    pub fn create_parsing_result_to(
        &self,
        index: usize,
        end_index: usize,
        start: Option<ParsingComponents>,
        end: Option<ParsingComponents>,
    ) -> ParsingResult {
        let text = self.text.get(index..end_index).unwrap_or("").to_string();
        ParsingResult::new(self.reference, index, text, start, end)
    }
}
