//! upstream `locales/vi/parsers/VITimeUnitCasualRelativeFormatParser.ts`.

use std::sync::LazyLock;

use crate::calculation::duration::{reverse_duration, Duration};
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::ParsingComponents;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::pattern::{dict_get, dict_keys, match_any_pattern};
use crate::locales::vi::constants::{parse_duration, NUMBER_PATTERN, TIME_UNIT_DICTIONARY};

pub const UPSTREAM: &str = "VITimeUnitCasualRelativeFormatParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(ViTimeUnitCasualRelativeFormatParser))
}

// tuần này  |  tháng trước  |  năm sau  |  tuần tới  |  2 tuần trước
// NUMBER is optional so bare unit words ("tuần này") are matched
static PATTERN: LazyLock<JsRegex> = LazyLock::new(|| {
    let casual_unit = format!(
        r"(?:{}\s{{0,5}})?(?:{})",
        *NUMBER_PATTERN,
        match_any_pattern(dict_keys(TIME_UNIT_DICTIONARY))
    );
    JsRegex::new(
        &format!(r"(này|trước|qua|sau|tới|tiếp)\s*({casual_unit})|({casual_unit})\s*(này|trước|qua|sau|tới|tiếp)(?=\W|$)"),
        "i",
    )
});

struct ViTimeUnitCasualRelativeFormatParser;

/// `match[i] || match[j] || ""`.
fn first_truthy(m: &RegexMatch, i: usize, j: usize) -> &str {
    [m.get(i), m.get(j)].into_iter().flatten().find(|s| !s.is_empty()).unwrap_or("")
}

impl WordBoundaryParser for ViTimeUnitCasualRelativeFormatParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        PATTERN.clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        // prefix form (trước tuần) or suffix form (tuần trước)
        let modifier = first_truthy(m, 1, 4).to_lowercase();
        let unit_text = first_truthy(m, 2, 3).to_lowercase();

        let mut duration = parse_duration(&unit_text);
        if duration.is_empty() {
            // bare unit word with no number: implies 1
            let Some(unit) = dict_get(TIME_UNIT_DICTIONARY, &unit_text) else {
                return Extracted::None;
            };
            duration = Duration::from_pairs(&[(unit, 1.0)]);
        }

        if modifier == "trước" || modifier == "qua" {
            duration = reverse_duration(&duration);
        }
        Extracted::Components(ParsingComponents::create_relative_from_reference(
            context.reference,
            &mut duration,
        ))
    }
}
