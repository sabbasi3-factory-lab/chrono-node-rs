//! upstream `locales/ar/parsers/ARTimeExpressionParser.ts`.
//!
//! Upstream overrides the pattern builders (Arabic-Indic digits, Arabic suffixes), which the shared
//! `TimeExpression` wrapper cannot express, so this implements `Parser` with the same `extract` flow
//! as `AbstractTimeExpressionParser`.

use std::sync::OnceLock;

use crate::common::time_expression::{
    self, AM_PM_HOUR_GROUP, HOUR_GROUP, MILLI_SECOND_GROUP, MINUTE_GROUP, SECOND_GROUP,
};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::{meridiem, Component, ParsingComponents};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::result::ParsingResult;
use crate::core::utils::js::js_parse_int;
use crate::js_regex;
use crate::locales::ar::constants::{to_western_digits, REGEX_PARTS};

pub const UPSTREAM: &str = "ARTimeExpressionParser";

const PRIMARY_LEFT_BOUNDARY: &str = r"(^|\s|T|(?:[^\p{L}\p{N}_]))";
const FOLLOWING_PHASE: &str = r"\s*(?:-|–|~|إلى|وحتى|حتى)\s*";
const PRIMARY_PREFIX: &str = r"(?:(?:في\s*تمام|في|الساعة|ساعة|من)\s*)??";
const DAYPART_SUFFIX: &str = r"(?:\s*(?:صباحاً|صباحا|مساءً|مساء|ليلاً|ليلا|عصراً|عصرا|ظهراً|ظهرا))?(?!/)";

pub fn create(flags: &Flags) -> Box<dyn Parser> {
    Box::new(ArTimeExpressionParser {
        strict_mode: flags.get("strictMode"),
        primary: OnceLock::new(),
        following: OnceLock::new(),
    })
}

fn primary_time_pattern() -> JsRegex {
    let source = format!(
        concat!(
            "{}{}",
            r"([0-9٠-٩]{{1,4}})",
            r"(?:",
            r"(?:\.|:|：)",
            r"([0-9٠-٩]{{1,2}})",
            r"(?:",
            r"(?::|：)",
            r"([0-9٠-٩]{{2}})",
            r"(?:\.([0-9٠-٩]{{1,6}}))?",
            r")?",
            r")?",
            r"(?:\s*(a\.m\.|p\.m\.|am?|pm?|ص|م))?",
            "{}{}",
        ),
        PRIMARY_LEFT_BOUNDARY, PRIMARY_PREFIX, DAYPART_SUFFIX, REGEX_PARTS.right_boundary
    );
    JsRegex::new(&source, REGEX_PARTS.flags)
}

fn following_time_pattern() -> JsRegex {
    let source = format!(
        concat!(
            r"^({})",
            r"([0-9٠-٩]{{1,4}})",
            r"(?:",
            r"(?:\.|:|：)",
            r"([0-9٠-٩]{{1,2}})",
            r"(?:",
            r"(?::|：)",
            r"([0-9٠-٩]{{1,2}})(?:\.([0-9٠-٩]{{1,6}}))?",
            r")?",
            r")?",
            r"(?:\s*(a\.m\.|p\.m\.|am?|pm?|ص|م))?",
            "{}{}",
        ),
        FOLLOWING_PHASE, DAYPART_SUFFIX, REGEX_PARTS.right_boundary
    );
    JsRegex::new(&source, "iu")
}

/// Converts groups 2..=5 to Western digits (a falsy group is left as is).
fn western_digit_groups(m: &RegexMatch) -> RegexMatch {
    let mut m = m.clone();
    for g in [HOUR_GROUP, MINUTE_GROUP, SECOND_GROUP, MILLI_SECOND_GROUP] {
        if let Some(Some(s)) = m.groups.get_mut(g) {
            if !s.is_empty() {
                *s = to_western_digits(s);
            }
        }
    }
    m
}

struct DayPart {
    is_pm: bool,
    is_am: bool,
    is_noon: bool,
}

fn day_part(m: &RegexMatch) -> DayPart {
    let ampm = m.get(AM_PM_HOUR_GROUP).unwrap_or("").to_lowercase();
    let full = m.text().to_lowercase();
    DayPart {
        is_pm: ampm == "م"
            || ampm == "pm"
            || ampm == "p"
            || ampm == "p.m."
            || js_regex!(r"(?:مساءً|مساء|ليلاً|ليلا|عصراً|عصرا)").is_match(&full),
        is_am: ampm == "ص"
            || ampm == "am"
            || ampm == "a"
            || ampm == "a.m."
            || js_regex!(r"(?:صباحاً|صباحا)").is_match(&full),
        is_noon: js_regex!(r"(?:ظهراً|ظهرا)").is_match(&full),
    }
}

fn apply_day_part(components: &mut ParsingComponents, p: &DayPart) {
    if p.is_pm {
        let hour = components.get_or_zero(Component::Hour);
        if hour < 12 {
            components.assign(Component::Hour, hour + 12);
        }
        components.assign(Component::Meridiem, meridiem::PM);
    } else if p.is_am {
        let hour = components.get(Component::Hour);
        if hour == Some(12) {
            components.assign(Component::Hour, 0);
        }
        components.assign(Component::Meridiem, meridiem::AM);
    } else if p.is_noon {
        let hour = components.get_or_zero(Component::Hour);
        if hour < 12 && hour != 0 {
            components.assign(Component::Hour, hour + 12);
        }
        components.assign(Component::Meridiem, meridiem::PM);
    }
}

struct ArTimeExpressionParser {
    strict_mode: bool,
    primary: OnceLock<JsRegex>,
    following: OnceLock<JsRegex>,
}

impl ArTimeExpressionParser {
    fn extract_primary_time_components(&self, context: &ParsingContext, m: &RegexMatch) -> Option<ParsingComponents> {
        let m = western_digit_groups(m);
        let mut components = time_expression::extract_primary_time_components(self.strict_mode, context, &m)?;
        apply_day_part(&mut components, &day_part(&m));
        Some(components)
    }

    fn extract_following_time_components(
        &self,
        context: &ParsingContext,
        m: &RegexMatch,
        result: &mut ParsingResult,
    ) -> Option<ParsingComponents> {
        let m = western_digit_groups(m);
        let mut components = time_expression::extract_following_time_components(context, &m, result)?;
        let p = day_part(&m);
        apply_day_part(&mut components, &p);

        // Propagate meridiem back to result.start if start did not specify AM/PM
        if !result.start.is_certain(Component::Meridiem) {
            if p.is_pm {
                result.start.imply(Component::Meridiem, meridiem::PM);
                let hour = result.start.get_or_zero(Component::Hour);
                if hour < 12 {
                    result.start.assign(Component::Hour, hour + 12);
                }
            } else if p.is_am {
                result.start.imply(Component::Meridiem, meridiem::AM);
                if result.start.get(Component::Hour) == Some(12) {
                    result.start.assign(Component::Hour, 0);
                }
            }
        }
        Some(components)
    }

    fn check_and_return_without_following_pattern(&self, result: ParsingResult) -> Option<ParsingResult> {
        let text = result.text.as_str();
        if js_regex!(r"^\d$").is_match(text) {
            return None;
        }
        if js_regex!(r"^\d\d\d+$").is_match(text) {
            return None;
        }
        if js_regex!(r"\d[apAP]$").is_match(text) {
            return None;
        }
        if let Some(ending) = js_regex!(r"[^\d:.](\d[\d.]+)$").exec(text) {
            let ending_numbers = ending.get(1).unwrap_or("");
            if self.strict_mode {
                return None;
            }
            if ending_numbers.contains('.') && !js_regex!(r"\d(\.\d{2})+$").is_match(ending_numbers) {
                return None;
            }
            if js_parse_int(ending_numbers).is_some_and(|v| v > 24) {
                return None;
            }
        }
        Some(result)
    }

    fn check_and_return_with_following_pattern(&self, result: ParsingResult) -> Option<ParsingResult> {
        let text = result.text.as_str();
        if js_regex!(r"^\d+-\d+$").is_match(text) {
            return None;
        }
        if let Some(ending) = js_regex!(r"[^\d:.](\d[\d.]+)\s*-\s*(\d[\d.]+)$").exec(text) {
            if self.strict_mode {
                return None;
            }
            let starting_numbers = ending.get(1).unwrap_or("");
            let ending_numbers = ending.get(2).unwrap_or("");
            if ending_numbers.contains('.') && !js_regex!(r"\d(\.\d{2})+$").is_match(ending_numbers) {
                return None;
            }
            let gt24 = |s: &str| js_parse_int(s).is_some_and(|v| v > 24);
            if gt24(ending_numbers) || gt24(starting_numbers) {
                return None;
            }
        }
        Some(result)
    }
}

impl Parser for ArTimeExpressionParser {
    fn pattern(&self, _context: &ParsingContext) -> JsRegex {
        self.primary.get_or_init(primary_time_pattern).clone()
    }

    fn extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let Some(start_components) = self.extract_primary_time_components(context, m) else {
            // If the match seem like a year e.g. "2013.12:...", skip the year part and try again.
            if js_regex!(r"^\d{4}").is_match(m.text()) {
                m.index += 4;
                return Extracted::None;
            }
            m.index += m.text().len();
            return Extracted::None;
        };

        let header_len = m.get(1).map_or(0, str::len);
        let index = m.index + header_len;
        let text = m.text()[header_len..].to_string();
        let mut result = context.create_parsing_result(index, text.clone(), Some(start_components), None);
        m.index += m.text().len();

        let remaining = context.text.get(m.index..).unwrap_or("");
        let following = self.following.get_or_init(following_time_pattern).exec(remaining);

        if let Some(f) = &following {
            if js_regex!(r"^\d{3,4}").is_match(&text) {
                if js_regex!(r"^\s*([+-])\s*\d{2,4}$").is_match(f.text()) {
                    return Extracted::None;
                }
                if js_regex!(r"^\s*([+-])\s*\d{2}\W\d{2}").is_match(f.text()) {
                    return Extracted::None;
                }
            }
        }

        let following = match following {
            Some(f) if !js_regex!(r"^\s*([+-])\s*\d{3,4}$").is_match(f.text()) => f,
            _ => {
                return self
                    .check_and_return_without_following_pattern(result)
                    .map_or(Extracted::None, Extracted::Result);
            }
        };

        result.end = self.extract_following_time_components(context, &following, &mut result);
        if result.end.is_some() {
            result.text.push_str(following.text());
        }

        self.check_and_return_with_following_pattern(result)
            .map_or(Extracted::None, Extracted::Result)
    }
}
