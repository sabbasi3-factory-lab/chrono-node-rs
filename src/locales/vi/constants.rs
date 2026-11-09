//! upstream `locales/vi/constants.ts`. Ported in full so parser tasks don't edit this file.
//!
//! Dictionaries are `(key, value)` slices **in upstream's key order**. It matters:
//! `match_any_pattern` sorts stably, so equal-length keys keep this order.

use std::sync::LazyLock;

use crate::calculation::duration::{Duration, DurationUnit};
use crate::calculation::years::find_most_likely_ad_year;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::js::{js_parse_float, js_parse_int, js_substring_from};
use crate::core::utils::pattern::{dict_get, dict_keys, js_len, match_any_pattern, repeated_timeunit_pattern, Dictionary};
use crate::js_regex;

pub static WEEKDAY_DICTIONARY: &Dictionary<i64> = &[
    ("chủ nhật", 0),
    ("cn", 0),
    ("thứ hai", 1),
    ("t2", 1),
    ("thứ ba", 2),
    ("t3", 2),
    ("thứ tư", 3),
    ("t4", 3),
    ("thứ năm", 4),
    ("t5", 4),
    ("thứ sáu", 5),
    ("t6", 5),
    ("thứ bảy", 6),
    ("t7", 6),
];

pub static MONTH_DICTIONARY: &Dictionary<i64> = &[
    ("tháng 1", 1),
    ("tháng một", 1),
    ("tháng giêng", 1),
    ("tháng 2", 2),
    ("tháng hai", 2),
    ("tháng 3", 3),
    ("tháng ba", 3),
    ("tháng 4", 4),
    ("tháng tư", 4),
    ("tháng 5", 5),
    ("tháng năm", 5),
    ("tháng 6", 6),
    ("tháng sáu", 6),
    ("tháng 7", 7),
    ("tháng bảy", 7),
    ("tháng 8", 8),
    ("tháng tám", 8),
    ("tháng 9", 9),
    ("tháng chín", 9),
    ("tháng 10", 10),
    ("tháng mười", 10),
    ("tháng 11", 11),
    ("tháng mười một", 11),
    ("tháng 12", 12),
    ("tháng mười hai", 12),
    ("tháng chạp", 12),
];

pub static INTEGER_WORD_DICTIONARY: &Dictionary<i64> = &[
    ("một", 1),
    ("hai", 2),
    ("ba", 3),
    ("bốn", 4),
    ("năm", 5),
    ("sáu", 6),
    ("bảy", 7),
    ("tám", 8),
    ("chín", 9),
    ("mười", 10),
    ("mười một", 11),
    ("mười hai", 12),
];

pub static TIME_UNIT_DICTIONARY: &Dictionary<DurationUnit> = &[
    ("giây", DurationUnit::Second),
    ("phút", DurationUnit::Minute),
    ("giờ", DurationUnit::Hour),
    ("ngày", DurationUnit::Day),
    ("tuần", DurationUnit::Week),
    ("tháng", DurationUnit::Month),
    ("năm", DurationUnit::Year),
];

pub static NUMBER_PATTERN: LazyLock<String> = LazyLock::new(|| {
    format!(
        r"(?:{}|[0-9]+|[0-9]+\.[0-9]+)",
        match_any_pattern(dict_keys(INTEGER_WORD_DICTIONARY))
    )
});

/// `parseNumberPattern(match)`. May be `NaN`.
pub fn parse_number_pattern(m: &str) -> f64 {
    let num = m.to_lowercase();
    if let Some(v) = dict_get(INTEGER_WORD_DICTIONARY, &num) {
        return v as f64;
    }
    js_parse_float(&num)
}

// YYYY, YYYY TCN (Trước Công nguyên = BC)
pub const YEAR_PATTERN: &str = r"(?:[0-9]{1,4}(?:\s*TCN)?)";

/// `parseYear(match)`. `None` is `NaN`.
pub fn parse_year(m: &str) -> Option<i64> {
    let upper = m.to_uppercase();
    // `match.replace(/[^0-9]+/g, "")`: keep only the ASCII digits.
    let digits: String = m.chars().filter(|c| c.is_ascii_digit()).collect();
    let num = js_parse_int(&digits);
    if js_regex!(r"TCN").is_match(&upper) {
        return num.map(|n| -n);
    }
    num.map(find_most_likely_ad_year)
}

static SINGLE_TIME_UNIT_PATTERN: LazyLock<String> = LazyLock::new(|| {
    format!(
        r"({})\s{{0,5}}({})\s{{0,5}}",
        *NUMBER_PATTERN,
        match_any_pattern(dict_keys(TIME_UNIT_DICTIONARY))
    )
});

static SINGLE_TIME_UNIT_REGEX: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new(&SINGLE_TIME_UNIT_PATTERN, "i"));

pub static TIME_UNITS_PATTERN: LazyLock<String> =
    LazyLock::new(|| repeated_timeunit_pattern("", &SINGLE_TIME_UNIT_PATTERN, None));

/// `parseDuration(timeunitText)`. An input with no time unit gives an empty duration (`{}`).
pub fn parse_duration(timeunit_text: &str) -> Duration {
    let mut fragments = Duration::new();
    let mut remaining = timeunit_text.to_string();
    let mut found = SINGLE_TIME_UNIT_REGEX.exec(&remaining);
    while let Some(m) = found {
        collect_fragment(&mut fragments, &m);
        // Upstream cuts `match[0].length` units from the *start*, not from the match position.
        remaining = js_substring_from(&remaining, js_len(m.text())).to_string();
        found = SINGLE_TIME_UNIT_REGEX.exec(&remaining);
    }
    fragments
}

fn collect_fragment(fragments: &mut Duration, m: &RegexMatch) {
    let num = parse_number_pattern(m.get(1).unwrap_or(""));
    // The regex only matches dictionary keys, so the lookup always succeeds.
    if let Some(unit) = dict_get(TIME_UNIT_DICTIONARY, &m.get(2).unwrap_or("").to_lowercase()) {
        fragments.set(unit, num);
    }
}

#[cfg(test)]
mod tests {
    //! Expected values were recorded from the pinned chrono-node (`contracts/vi/constants.yaml`).
    use super::*;

    fn dict_is<V: Copy + PartialEq + std::fmt::Debug>(d: &Dictionary<V>, expect: &[(&str, V)]) {
        assert_eq!(d, expect);
    }

    fn num(input: &str, expect: Option<f64>) {
        let v = parse_number_pattern(input);
        match expect {
            Some(e) => assert_eq!(v, e),
            None => assert!(v.is_nan()),
        }
    }

    fn dur(input: &str, expect: &[(DurationUnit, f64)]) {
        let d = parse_duration(input);
        assert_eq!(d.iter().collect::<Vec<_>>(), expect.to_vec());
    }

    #[test]
    fn weekday_dictionary_matches_upstream() {
        dict_is(
            WEEKDAY_DICTIONARY,
            &[
                ("chủ nhật", 0),
                ("cn", 0),
                ("thứ hai", 1),
                ("t2", 1),
                ("thứ ba", 2),
                ("t3", 2),
                ("thứ tư", 3),
                ("t4", 3),
                ("thứ năm", 4),
                ("t5", 4),
                ("thứ sáu", 5),
                ("t6", 5),
                ("thứ bảy", 6),
                ("t7", 6),
            ],
        );
    }

    #[test]
    fn month_dictionary_matches_upstream() {
        dict_is(
            MONTH_DICTIONARY,
            &[
                ("tháng 1", 1),
                ("tháng một", 1),
                ("tháng giêng", 1),
                ("tháng 2", 2),
                ("tháng hai", 2),
                ("tháng 3", 3),
                ("tháng ba", 3),
                ("tháng 4", 4),
                ("tháng tư", 4),
                ("tháng 5", 5),
                ("tháng năm", 5),
                ("tháng 6", 6),
                ("tháng sáu", 6),
                ("tháng 7", 7),
                ("tháng bảy", 7),
                ("tháng 8", 8),
                ("tháng tám", 8),
                ("tháng 9", 9),
                ("tháng chín", 9),
                ("tháng 10", 10),
                ("tháng mười", 10),
                ("tháng 11", 11),
                ("tháng mười một", 11),
                ("tháng 12", 12),
                ("tháng mười hai", 12),
                ("tháng chạp", 12),
            ],
        );
    }

    #[test]
    fn integer_word_dictionary_matches_upstream() {
        dict_is(
            INTEGER_WORD_DICTIONARY,
            &[
                ("một", 1),
                ("hai", 2),
                ("ba", 3),
                ("bốn", 4),
                ("năm", 5),
                ("sáu", 6),
                ("bảy", 7),
                ("tám", 8),
                ("chín", 9),
                ("mười", 10),
                ("mười một", 11),
                ("mười hai", 12),
            ],
        );
    }

    #[test]
    fn time_unit_dictionary_matches_upstream() {
        dict_is(
            TIME_UNIT_DICTIONARY,
            &[
                ("giây", DurationUnit::Second),
                ("phút", DurationUnit::Minute),
                ("giờ", DurationUnit::Hour),
                ("ngày", DurationUnit::Day),
                ("tuần", DurationUnit::Week),
                ("tháng", DurationUnit::Month),
                ("năm", DurationUnit::Year),
            ],
        );
    }

    #[test]
    fn number_pattern_matches_upstream() {
        assert_eq!(
            *NUMBER_PATTERN,
            r"(?:(?:mười một|mười hai|chín|mười|một|hai|bốn|năm|sáu|bảy|tám|ba)|[0-9]+|[0-9]+\.[0-9]+)"
        );
    }

    #[test]
    fn parse_number_pattern_case_1() {
        num("0", Some(0.0));
    }
    #[test]
    fn parse_number_pattern_case_2() {
        num("ba", Some(3.0));
    }
    #[test]
    fn parse_number_pattern_case_3() {
        num("1", Some(1.0));
    }
    #[test]
    fn parse_number_pattern_case_4() {
        num("cn", None);
    }
    #[test]
    fn parse_number_pattern_case_5() {
        num("2", Some(2.0));
    }
    #[test]
    fn parse_number_pattern_case_6() {
        num("bảy", Some(7.0));
    }
    #[test]
    fn parse_number_pattern_case_7() {
        num("7 giờ", Some(7.0));
    }
    #[test]
    fn parse_number_pattern_case_8() {
        num("1 giờ ", Some(1.0));
    }

    #[test]
    fn year_pattern_matches_upstream() {
        assert_eq!(YEAR_PATTERN, r"(?:[0-9]{1,4}(?:\s*TCN)?)");
    }

    #[test]
    fn parse_year_case_1() {
        assert_eq!(parse_year("0"), Some(2000));
    }
    #[test]
    fn parse_year_case_2() {
        assert_eq!(parse_year("ba"), None);
    }
    #[test]
    fn parse_year_case_3() {
        assert_eq!(parse_year("1"), Some(2001));
    }
    #[test]
    fn parse_year_case_4() {
        assert_eq!(parse_year("2"), Some(2002));
    }
    #[test]
    fn parse_year_case_5() {
        assert_eq!(parse_year("t2"), Some(2002));
    }
    #[test]
    fn parse_year_case_6() {
        assert_eq!(parse_year("t3"), Some(2003));
    }
    #[test]
    fn parse_year_case_7() {
        assert_eq!(parse_year("t4"), Some(2004));
    }

    #[test]
    fn time_units_pattern_matches_upstream() {
        assert_eq!(
            *TIME_UNITS_PATTERN,
            r"(?:(?:(?:mười một|mười hai|chín|mười|một|hai|bốn|năm|sáu|bảy|tám|ba)|[0-9]+|[0-9]+\.[0-9]+))\s{0,5}(?:(?:tháng|giây|phút|ngày|tuần|giờ|năm))\s{0,5}(?:\s{0,5},?\s{0,5}(?:(?:(?:mười một|mười hai|chín|mười|một|hai|bốn|năm|sáu|bảy|tám|ba)|[0-9]+|[0-9]+\.[0-9]+))\s{0,5}(?:(?:tháng|giây|phút|ngày|tuần|giờ|năm))\s{0,5}){0,10}"
        );
    }

    #[test]
    fn parse_duration_case_1() {
        dur("0", &[]);
    }
    #[test]
    fn parse_duration_case_2() {
        dur("7 giờ", &[(DurationUnit::Hour, 7.0)]);
    }
    #[test]
    fn parse_duration_case_3() {
        dur("1 giờ ", &[(DurationUnit::Hour, 1.0)]);
    }
    #[test]
    fn parse_duration_case_4() {
        dur("1 năm ", &[(DurationUnit::Year, 1.0)]);
    }
    #[test]
    fn parse_duration_case_5() {
        dur("ba ngày ", &[(DurationUnit::Day, 3.0)]);
    }
    #[test]
    fn parse_duration_case_6() {
        dur("hai tuần ", &[(DurationUnit::Week, 2.0)]);
    }
    #[test]
    fn parse_duration_case_7() {
        dur("một tháng ", &[(DurationUnit::Month, 1.0)]);
    }
}
