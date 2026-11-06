//! upstream `locales/uk/parsers/UKTimeUnitWithinFormatParser.ts`.

use std::sync::LazyLock;

use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::ParsingComponents;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::locales::uk::constants::{parse_duration, FLAGS, LEFT_BOUNDARY, RIGHT_BOUNDARY, TIME_UNITS_PATTERN};

pub const UPSTREAM: &str = "UKTimeUnitWithinFormatParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(UkTimeUnitWithinFormatParser))
}

static PATTERN: LazyLock<String> =
    LazyLock::new(|| format!(r"(?:(?:приблизно|орієнтовно)\s*(?:~\s*)?)?({}){}", *TIME_UNITS_PATTERN, RIGHT_BOUNDARY));

static FORWARD_REGEX: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new(&PATTERN, FLAGS));

static WITHIN_REGEX: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new(&format!(r"(?:протягом|на протязі|протягом|упродовж|впродовж)\s*{}", *PATTERN), FLAGS));

struct UkTimeUnitWithinFormatParser;

impl WordBoundaryParser for UkTimeUnitWithinFormatParser {
    fn pattern_left_boundary(&self) -> &str {
        LEFT_BOUNDARY
    }

    fn inner_pattern(&self, context: &ParsingContext) -> JsRegex {
        if context.option.forward_date {
            FORWARD_REGEX.clone()
        } else {
            WITHIN_REGEX.clone()
        }
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let mut time_units = parse_duration(m.get(1).unwrap_or(""));
        Extracted::Components(ParsingComponents::create_relative_from_reference(
            context.reference,
            &mut time_units,
        ))
    }
}
