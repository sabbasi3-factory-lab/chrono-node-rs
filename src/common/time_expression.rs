//! upstream `common/parsers/AbstractTimeExpressionParser.ts`.
//!
//! Implement [`TimeExpressionParser`] for a locale and wrap it: `Box::new(TimeExpression::new(p))`.
//! Upstream's `super.extractPrimaryTimeComponents(...)` is [`extract_primary_time_components`],
//! and `super.extractFollowingTimeComponents(...)` is [`extract_following_time_components`].

use std::sync::OnceLock;

use crate::calculation::duration::{Duration, DurationUnit};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::{meridiem, Component, ParsingComponents};
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::result::ParsingResult;
use crate::core::utils::js::js_parse_int;
use crate::js_regex;

const DEFAULT_SUFFIX: &str = r"(?!/)(?=\W|$)";

fn primary_time_pattern(left_boundary: &str, primary_prefix: &str, primary_suffix: &str, flags: &str) -> JsRegex {
    let source = format!(
        concat!(
            "{}{}",
            r"(\d{{1,4}})",
            r"(?:",
            r"(?:\.|:|：)",
            r"(\d{{1,2}})",
            r"(?:",
            r"(?::|：)",
            r"(\d{{2}})",
            r"(?:\.(\d{{1,6}}))?",
            r")?",
            r")?",
            r"(?:\s*(a\.m\.|p\.m\.|am?|pm?))?",
            "{}",
        ),
        left_boundary, primary_prefix, primary_suffix
    );
    JsRegex::new(&source, flags)
}

fn following_time_pattern(following_phase: &str, following_suffix: &str) -> JsRegex {
    let source = format!(
        concat!(
            r"^({})",
            r"(\d{{1,4}})",
            r"(?:",
            r"(?:\.|\:|\：)",
            r"(\d{{1,2}})",
            r"(?:",
            r"(?:\.|\:|\：)",
            r"(\d{{1,2}})(?:\.(\d{{1,6}}))?",
            r")?",
            r")?",
            r"(?:\s*(a\.m\.|p\.m\.|am?|pm?))?",
            "{}",
        ),
        following_phase, following_suffix
    );
    JsRegex::new(&source, "i")
}

pub const HOUR_GROUP: usize = 2;
pub const MINUTE_GROUP: usize = 3;
pub const SECOND_GROUP: usize = 4;
pub const MILLI_SECOND_GROUP: usize = 5;
pub const AM_PM_HOUR_GROUP: usize = 6;

/// The abstract members of `AbstractTimeExpressionParser`, with upstream's defaults.
pub trait TimeExpressionParser: Send + Sync {
    fn strict_mode(&self) -> bool;
    fn primary_prefix(&self) -> &str;
    fn following_phase(&self) -> &str;

    fn pattern_flags(&self) -> &str {
        "i"
    }
    fn primary_pattern_left_boundary(&self) -> &str {
        r"(^|\s|T|\b)"
    }
    fn primary_suffix(&self) -> &str {
        DEFAULT_SUFFIX
    }
    fn following_suffix(&self) -> &str {
        DEFAULT_SUFFIX
    }

    fn extract_primary_time_components(&self, context: &ParsingContext, m: &RegexMatch) -> Option<ParsingComponents> {
        extract_primary_time_components(self.strict_mode(), context, m)
    }

    fn extract_following_time_components(
        &self,
        context: &ParsingContext,
        m: &RegexMatch,
        result: &mut ParsingResult,
    ) -> Option<ParsingComponents> {
        extract_following_time_components(context, m, result)
    }
}

/// JS truthiness of an optional group: `undefined` and `""` are falsy.
fn truthy(group: Option<&str>) -> bool {
    group.is_some_and(|g| !g.is_empty())
}

fn first_char_lower(s: &str) -> String {
    s.chars().next().map(|c| c.to_lowercase().collect()).unwrap_or_default()
}

/// `parseInt(match[group])`, with JS `NaN` as `None`.
fn int_group(m: &RegexMatch, group: usize) -> Option<i64> {
    m.get(group).and_then(js_parse_int)
}

/// `parseInt(match[MILLI_SECOND_GROUP].substring(0, 3))` (the group is ASCII digits).
fn millisecond_group(m: &RegexMatch) -> Option<i64> {
    m.get(MILLI_SECOND_GROUP)
        .and_then(|g| js_parse_int(&g[..g.len().min(3)]))
}

/// upstream `extractPrimaryTimeComponents` (the base implementation).
pub fn extract_primary_time_components(
    strict_mode: bool,
    context: &ParsingContext,
    m: &RegexMatch,
) -> Option<ParsingComponents> {
    let mut components = context.create_parsing_components(&[]);
    let mut minute = 0;
    let mut meridiem_value: Option<i64> = None;

    // ----- Hours
    let mut hour = int_group(m, HOUR_GROUP)?;
    if hour > 100 {
        // When time is like '2019', it is more likely a year.
        if m.get(HOUR_GROUP).map_or(0, str::len) == 4
            && m.get(MINUTE_GROUP).is_none()
            && !truthy(m.get(AM_PM_HOUR_GROUP))
        {
            return None;
        }
        if strict_mode || m.get(MINUTE_GROUP).is_some() {
            return None;
        }
        minute = hour % 100;
        hour /= 100;
    }

    if hour > 24 {
        return None;
    }

    // ----- Minutes
    if let Some(minute_text) = m.get(MINUTE_GROUP) {
        if minute_text.len() == 1 && !truthy(m.get(AM_PM_HOUR_GROUP)) {
            // Skip single digit minute e.g. "at 1.1 xx"
            return None;
        }
        minute = int_group(m, MINUTE_GROUP)?;
    }

    if minute >= 60 {
        return None;
    }

    if hour > 12 {
        meridiem_value = Some(meridiem::PM);
    }

    // ----- AM & PM
    if let Some(ampm_text) = m.get(AM_PM_HOUR_GROUP) {
        if hour > 12 {
            return None;
        }
        let ampm = first_char_lower(ampm_text);
        if ampm == "a" {
            meridiem_value = Some(meridiem::AM);
            if hour == 12 {
                hour = 0;
            }
        }
        if ampm == "p" {
            meridiem_value = Some(meridiem::PM);
            if hour != 12 {
                hour += 12;
            }
        }
    }

    components.assign(Component::Hour, hour);
    components.assign(Component::Minute, minute);

    match meridiem_value {
        Some(v) => {
            components.assign(Component::Meridiem, v);
        }
        None => {
            components.imply(Component::Meridiem, if hour < 12 { meridiem::AM } else { meridiem::PM });
        }
    }

    // ----- Millisecond
    if m.get(MILLI_SECOND_GROUP).is_some() {
        let millisecond = millisecond_group(m)?;
        if millisecond >= 1000 {
            return None;
        }
        components.assign(Component::Millisecond, millisecond);
    }

    // ----- Second
    if m.get(SECOND_GROUP).is_some() {
        let second = int_group(m, SECOND_GROUP)?;
        if second >= 60 {
            return None;
        }
        components.assign(Component::Second, second);
    }

    Some(components)
}

/// upstream `extractFollowingTimeComponents` (the base implementation). May adjust `result.start`.
pub fn extract_following_time_components(
    context: &ParsingContext,
    m: &RegexMatch,
    result: &mut ParsingResult,
) -> Option<ParsingComponents> {
    let mut components = context.create_parsing_components(&[]);

    // ----- Millisecond
    if m.get(MILLI_SECOND_GROUP).is_some() {
        let millisecond = millisecond_group(m)?;
        if millisecond >= 1000 {
            return None;
        }
        components.assign(Component::Millisecond, millisecond);
    }

    // ----- Second
    if m.get(SECOND_GROUP).is_some() {
        let second = int_group(m, SECOND_GROUP)?;
        if second >= 60 {
            return None;
        }
        components.assign(Component::Second, second);
    }

    let mut hour = int_group(m, HOUR_GROUP)?;
    let mut minute = 0;
    let mut meridiem_value: i64 = -1;

    // ----- Minute
    if m.get(MINUTE_GROUP).is_some() {
        minute = int_group(m, MINUTE_GROUP)?;
    } else if hour > 100 {
        minute = hour % 100;
        hour /= 100;
    }

    if minute >= 60 || hour > 24 {
        return None;
    }

    if hour >= 12 {
        meridiem_value = meridiem::PM;
    }

    // ----- AM & PM
    if let Some(ampm_text) = m.get(AM_PM_HOUR_GROUP) {
        if hour > 12 {
            return None;
        }
        let ampm = first_char_lower(ampm_text);
        if ampm == "a" {
            meridiem_value = meridiem::AM;
            if hour == 12 {
                hour = 0;
                if !components.is_certain(Component::Day) {
                    components.add_duration_as_implied(&mut Duration::from_pairs(&[(DurationUnit::Day, 1.0)]));
                }
            }
        }
        if ampm == "p" {
            meridiem_value = meridiem::PM;
            if hour != 12 {
                hour += 12;
            }
        }

        if !result.start.is_certain(Component::Meridiem) {
            if meridiem_value == meridiem::AM {
                result.start.imply(Component::Meridiem, meridiem::AM);
                if result.start.get(Component::Hour) == Some(12) {
                    result.start.assign(Component::Hour, 0);
                }
            } else {
                result.start.imply(Component::Meridiem, meridiem::PM);
                if result.start.get(Component::Hour) != Some(12) {
                    let start_hour = result.start.get_or_zero(Component::Hour);
                    result.start.assign(Component::Hour, start_hour + 12);
                }
            }
        }
    }

    components.assign(Component::Hour, hour);
    components.assign(Component::Minute, minute);

    if meridiem_value >= 0 {
        components.assign(Component::Meridiem, meridiem_value);
    } else {
        let start_hour = result.start.get_or_zero(Component::Hour);
        let start_at_pm = result.start.is_certain(Component::Meridiem) && start_hour > 12;
        if start_at_pm {
            if start_hour - 12 > hour {
                // 10pm - 1 (am)
                components.imply(Component::Meridiem, meridiem::AM);
            } else if hour <= 12 {
                components.assign(Component::Hour, hour + 12);
                components.assign(Component::Meridiem, meridiem::PM);
            }
        } else if hour > 12 {
            components.imply(Component::Meridiem, meridiem::PM);
        } else if hour <= 12 {
            components.imply(Component::Meridiem, meridiem::AM);
        }
    }

    if let (Some(end), Some(start)) = (components.date().get_time(), result.start.date().get_time()) {
        if end < start {
            components.add_duration_as_implied(&mut Duration::from_pairs(&[(DurationUnit::Day, 1.0)]));
        }
    }

    Some(components)
}

/// The concrete `AbstractTimeExpressionParser`: pattern caching and the `extract` flow.
pub struct TimeExpression<P> {
    inner: P,
    primary: OnceLock<JsRegex>,
    following: OnceLock<JsRegex>,
}

impl<P: TimeExpressionParser> TimeExpression<P> {
    pub fn new(inner: P) -> TimeExpression<P> {
        TimeExpression {
            inner,
            primary: OnceLock::new(),
            following: OnceLock::new(),
        }
    }

    fn primary_pattern(&self) -> &JsRegex {
        self.primary.get_or_init(|| {
            primary_time_pattern(
                self.inner.primary_pattern_left_boundary(),
                self.inner.primary_prefix(),
                self.inner.primary_suffix(),
                self.inner.pattern_flags(),
            )
        })
    }

    fn following_pattern(&self) -> &JsRegex {
        self.following
            .get_or_init(|| following_time_pattern(self.inner.following_phase(), self.inner.following_suffix()))
    }

    fn check_and_return_without_following_pattern(&self, result: ParsingResult) -> Option<ParsingResult> {
        let text = result.text.as_str();
        // Single digit (e.g "1") should not be counted as time expression (without proper context)
        if js_regex!(r"^\d$").is_match(text) {
            return None;
        }
        // Three or more digit (e.g. "203", "2014") should not be counted as time expression
        if js_regex!(r"^\d\d\d+$").is_match(text) {
            return None;
        }
        // Instead of "am/pm", it ends with "a" or "p" (e.g "1a", "123p"), this seems unlikely
        if js_regex!(r"\d[apAP]$").is_match(text) {
            return None;
        }
        // If it ends only with numbers or dots
        if let Some(ending) = js_regex!(r"[^\d:.](\d[\d.]+)$").exec(text) {
            let ending_numbers = ending.get(1).unwrap_or("");
            // In strict mode (e.g. "at 1" or "at 1.2"), this should not be accepted
            if self.inner.strict_mode() {
                return None;
            }
            // If it ends only with dot single digit, e.g. "at 1.2"
            if ending_numbers.contains('.') && !js_regex!(r"\d(\.\d{2})+$").is_match(ending_numbers) {
                return None;
            }
            // If it ends only with numbers above 24, e.g. "at 25"
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
        // If it ends only with numbers or dots
        if let Some(ending) = js_regex!(r"[^\d:.](\d[\d.]+)\s*-\s*(\d[\d.]+)$").exec(text) {
            // In strict mode (e.g. "at 1-3" or "at 1.2 - 2.3"), this should not be accepted
            if self.inner.strict_mode() {
                return None;
            }
            let starting_numbers = ending.get(1).unwrap_or("");
            let ending_numbers = ending.get(2).unwrap_or("");
            // If it ends only with dot single digit, e.g. "at 1.2"
            if ending_numbers.contains('.') && !js_regex!(r"\d(\.\d{2})+$").is_match(ending_numbers) {
                return None;
            }
            // If it ends only with numbers above 24, e.g. "at 25"
            let gt24 = |s: &str| js_parse_int(s).is_some_and(|v| v > 24);
            if gt24(ending_numbers) || gt24(starting_numbers) {
                return None;
            }
        }
        Some(result)
    }
}

impl<P: TimeExpressionParser> Parser for TimeExpression<P> {
    fn pattern(&self, _context: &ParsingContext) -> JsRegex {
        self.primary_pattern().clone()
    }

    fn extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let Some(start_components) = self.inner.extract_primary_time_components(context, m) else {
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
        let following = self.following_pattern().exec(remaining);

        // Pattern "456-12", "2022-12" should not be time without proper context
        if let Some(f) = &following {
            if js_regex!(r"^\d{3,4}").is_match(&text) {
                // e.g. "2022-12"
                if js_regex!(r"^\s*([+-])\s*\d{2,4}$").is_match(f.text()) {
                    return Extracted::None;
                }
                // e.g. "2022-12:01..."
                if js_regex!(r"^\s*([+-])\s*\d{2}\W\d{2}").is_match(f.text()) {
                    return Extracted::None;
                }
            }
        }

        let following = match following {
            // Pattern "YY.YY -XXXX" is more like timezone offset
            Some(f) if !js_regex!(r"^\s*([+-])\s*\d{3,4}$").is_match(f.text()) => f,
            _ => {
                return self
                    .check_and_return_without_following_pattern(result)
                    .map_or(Extracted::None, Extracted::Result);
            }
        };

        result.end = self
            .inner
            .extract_following_time_components(context, &following, &mut result);
        if result.end.is_some() {
            result.text.push_str(following.text());
        }

        self.check_and_return_with_following_pattern(result)
            .map_or(Extracted::None, Extracted::Result)
    }
}
