//! upstream `locales/id/constants.ts`. Ported in full so parser tasks don't edit this file.
//!
//! Dictionaries are `(key, value)` slices **in upstream's key order**. It matters:
//! `match_any_pattern` sorts stably, so equal-length keys keep this order.

use std::sync::LazyLock;

use crate::calculation::duration::{Duration, DurationUnit};
use crate::calculation::years::find_most_likely_ad_year;
use crate::core::regex::JsRegex;
use crate::core::utils::js::{js_parse_float, js_parse_int};
use crate::core::utils::pattern::{
    dict_get, dict_keys, match_any_pattern, repeated_timeunit_pattern, Dictionary,
};

/// "minggu" means both "Sunday" and "week"; "ahad" is unambiguous.
pub static WEEKDAY_DICTIONARY: &Dictionary<i64> = &[
    ("minggu", 0),
    ("ahad", 0),
    ("senin", 1),
    ("selasa", 2),
    ("rabu", 3),
    ("kamis", 4),
    ("jumat", 5),
    ("jum'at", 5),
    ("sabtu", 6),
];

pub static MONTH_DICTIONARY: &Dictionary<i64> = &[
    ("januari", 1),
    ("jan", 1),
    ("jan.", 1),
    ("februari", 2),
    ("pebruari", 2),
    ("feb", 2),
    ("feb.", 2),
    ("peb", 2),
    ("peb.", 2),
    ("maret", 3),
    ("mar", 3),
    ("mar.", 3),
    ("april", 4),
    ("apr", 4),
    ("apr.", 4),
    ("mei", 5),
    ("juni", 6),
    ("jun", 6),
    ("jun.", 6),
    ("juli", 7),
    ("jul", 7),
    ("jul.", 7),
    ("agustus", 8),
    ("agu", 8),
    ("agu.", 8),
    ("agt", 8),
    ("agt.", 8),
    ("ags", 8),
    ("ags.", 8),
    ("september", 9),
    ("sep", 9),
    ("sep.", 9),
    ("sept", 9),
    ("sept.", 9),
    ("oktober", 10),
    ("okt", 10),
    ("okt.", 10),
    ("november", 11),
    ("nopember", 11),
    ("nov", 11),
    ("nov.", 11),
    ("nop", 11),
    ("nop.", 11),
    ("desember", 12),
    ("des", 12),
    ("des.", 12),
];

pub static INTEGER_WORD_DICTIONARY: &Dictionary<i64> = &[
    ("satu", 1),
    ("dua", 2),
    ("tiga", 3),
    ("empat", 4),
    ("lima", 5),
    ("enam", 6),
    ("tujuh", 7),
    ("delapan", 8),
    ("sembilan", 9),
    ("sepuluh", 10),
    ("sebelas", 11),
    ("dua belas", 12),
];

pub static TIME_UNIT_DICTIONARY: &Dictionary<DurationUnit> = &[
    ("detik", DurationUnit::Second),
    ("menit", DurationUnit::Minute),
    ("jam", DurationUnit::Hour),
    ("hari", DurationUnit::Day),
    ("minggu", DurationUnit::Week),
    ("pekan", DurationUnit::Week),
    ("bulan", DurationUnit::Month),
    ("tahun", DurationUnit::Year),
];

pub static NUMBER_PATTERN: LazyLock<String> = LazyLock::new(|| {
    format!(
        r"(?:{}|[0-9]+|[0-9]+[\.,][0-9]+|setengah)",
        match_any_pattern(dict_keys(INTEGER_WORD_DICTIONARY))
    )
});

/// `parseNumberPattern(match)`. `None` is `NaN`.
pub fn parse_number_pattern(m: &str) -> Option<f64> {
    let num = m.to_lowercase();
    if let Some(v) = dict_get(INTEGER_WORD_DICTIONARY, &num) {
        return Some(v as f64);
    } else if num == "setengah" {
        return Some(0.5);
    }
    // Indonesian uses "," as the decimal separator
    let n = js_parse_float(&num.replacen(',', ".", 1));
    if n.is_nan() {
        None
    } else {
        Some(n)
    }
}

// 1945  |  45  |  500 SM (Sebelum Masehi = BC)  |  2024 M (Masehi = AD)
pub const YEAR_PATTERN: &str = r"(?:[1-9][0-9]{0,3}\s*(?:SM|M)(?=\W|$)|[1-2][0-9]{3}|[5-9][0-9])";

/// `str.replace(/<needle>/i, "")` for an ASCII needle (JS `i` without `u` folds only ASCII here).
fn remove_first_ignore_case(s: &str, needle: &str) -> String {
    let lower = s.to_ascii_lowercase();
    match lower.find(&needle.to_ascii_lowercase()) {
        Some(i) => format!("{}{}", &s[..i], &s[i + needle.len()..]),
        None => s.to_string(),
    }
}

fn contains_ignore_case(s: &str, needle: &str) -> bool {
    s.to_ascii_lowercase().contains(&needle.to_ascii_lowercase())
}

/// `parseYear(match)`. `None` is `NaN`.
pub fn parse_year(m: &str) -> Option<i64> {
    if contains_ignore_case(m, "SM") {
        return js_parse_int(&remove_first_ignore_case(m, "SM")).map(|n| -n);
    }
    if contains_ignore_case(m, "M") {
        return js_parse_int(&remove_first_ignore_case(m, "M"));
    }
    js_parse_int(m).map(find_most_likely_ad_year)
}

// "3 hari"  |  "dua minggu"  |  "sebulan" (se- prefix = one)
static SINGLE_TIME_UNIT_PATTERN: LazyLock<String> = LazyLock::new(|| {
    format!(
        r"(?:({})\s{{0,5}}|se)({})\s{{0,5}}",
        *NUMBER_PATTERN,
        match_any_pattern(dict_keys(TIME_UNIT_DICTIONARY))
    )
});

static SINGLE_TIME_UNIT_REGEX: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new(&SINGLE_TIME_UNIT_PATTERN, "i"));

pub static TIME_UNITS_PATTERN: LazyLock<String> =
    LazyLock::new(|| repeated_timeunit_pattern("", &SINGLE_TIME_UNIT_PATTERN, Some(r"\s{0,5}(?:,|dan)?\s{0,5}")));

/// `parseDuration(timeunitText)`. An input with no time unit gives an empty duration.
pub fn parse_duration(timeunit_text: &str) -> Duration {
    let mut fragments = Duration::new();
    let mut remaining = timeunit_text.to_string();
    let mut found = SINGLE_TIME_UNIT_REGEX.exec(&remaining);
    while let Some(m) = found {
        let num = match m.get(1).filter(|s| !s.is_empty()) {
            Some(s) => parse_number_pattern(s).unwrap_or(f64::NAN),
            None => 1.0,
        };
        if let Some(unit) = dict_get(TIME_UNIT_DICTIONARY, &m.get(2).unwrap_or("").to_lowercase()) {
            fragments.set(unit, num);
        }
        // Upstream cuts `match.index + match[0].length` UTF-16 units from the start.
        let end = m.index + m.text().len();
        remaining = remaining[end..].to_string();
        found = SINGLE_TIME_UNIT_REGEX.exec(&remaining);
    }
    fragments
}

#[cfg(test)]
mod tests {
    use super::*;
    use DurationUnit::*;

    fn sorted<V: Copy>(d: &Dictionary<V>, f: impl Fn(V) -> String) -> Vec<(&'static str, String)> {
        let mut v: Vec<_> = d.iter().map(|&(k, x)| (k, f(x))).collect();
        v.sort();
        v
    }

    fn expected(pairs: &[(&'static str, i64)]) -> Vec<(&'static str, String)> {
        let mut v: Vec<_> = pairs.iter().map(|&(k, x)| (k, x.to_string())).collect();
        v.sort();
        v
    }

    #[test]
    fn weekday_dictionary_matches_upstream() {
        let want = expected(&[
            ("minggu", 0),
            ("ahad", 0),
            ("senin", 1),
            ("selasa", 2),
            ("rabu", 3),
            ("kamis", 4),
            ("jumat", 5),
            ("jum'at", 5),
            ("sabtu", 6),
        ]);
        assert_eq!(sorted(WEEKDAY_DICTIONARY, |x| x.to_string()), want);
    }

    #[test]
    fn month_dictionary_matches_upstream() {
        let want = expected(&[
            ("januari", 1),
            ("jan", 1),
            ("jan.", 1),
            ("februari", 2),
            ("pebruari", 2),
            ("feb", 2),
            ("feb.", 2),
            ("peb", 2),
            ("peb.", 2),
            ("maret", 3),
            ("mar", 3),
            ("mar.", 3),
            ("april", 4),
            ("apr", 4),
            ("apr.", 4),
            ("mei", 5),
            ("juni", 6),
            ("jun", 6),
            ("jun.", 6),
            ("juli", 7),
            ("jul", 7),
            ("jul.", 7),
            ("agustus", 8),
            ("agu", 8),
            ("agu.", 8),
            ("agt", 8),
            ("agt.", 8),
            ("ags", 8),
            ("ags.", 8),
            ("september", 9),
            ("sep", 9),
            ("sep.", 9),
            ("sept", 9),
            ("sept.", 9),
            ("oktober", 10),
            ("okt", 10),
            ("okt.", 10),
            ("november", 11),
            ("nopember", 11),
            ("nov", 11),
            ("nov.", 11),
            ("nop", 11),
            ("nop.", 11),
            ("desember", 12),
            ("des", 12),
            ("des.", 12),
        ]);
        assert_eq!(sorted(MONTH_DICTIONARY, |x| x.to_string()), want);
    }

    #[test]
    fn integer_word_dictionary_matches_upstream() {
        let want = expected(&[
            ("satu", 1),
            ("dua", 2),
            ("tiga", 3),
            ("empat", 4),
            ("lima", 5),
            ("enam", 6),
            ("tujuh", 7),
            ("delapan", 8),
            ("sembilan", 9),
            ("sepuluh", 10),
            ("sebelas", 11),
            ("dua belas", 12),
        ]);
        assert_eq!(sorted(INTEGER_WORD_DICTIONARY, |x| x.to_string()), want);
    }

    #[test]
    fn time_unit_dictionary_matches_upstream() {
        let want = [
            ("detik", "second"),
            ("menit", "minute"),
            ("jam", "hour"),
            ("hari", "day"),
            ("minggu", "week"),
            ("pekan", "week"),
            ("bulan", "month"),
            ("tahun", "year"),
        ];
        let mut want: Vec<_> = want.iter().map(|&(k, v)| (k, v.to_string())).collect();
        want.sort();
        assert_eq!(sorted(TIME_UNIT_DICTIONARY, |u| u.key().to_string()), want);
    }

    #[test]
    fn number_pattern_matches_upstream() {
        assert_eq!(
            *NUMBER_PATTERN,
            r"(?:(?:dua belas|sembilan|delapan|sepuluh|sebelas|empat|tujuh|satu|tiga|lima|enam|dua)|[0-9]+|[0-9]+[\.,][0-9]+|setengah)"
        );
    }

    #[test]
    fn parse_number_pattern_case_1() {
        assert_eq!(parse_number_pattern("1"), Some(1.0));
    }

    #[test]
    fn parse_number_pattern_case_2() {
        assert_eq!(parse_number_pattern("ags"), None);
    }

    #[test]
    fn parse_number_pattern_case_3() {
        assert_eq!(parse_number_pattern("2"), Some(2.0));
    }

    #[test]
    fn parse_number_pattern_case_4() {
        assert_eq!(parse_number_pattern("3"), Some(3.0));
    }

    #[test]
    fn parse_number_pattern_case_5() {
        assert_eq!(parse_number_pattern("dua"), Some(2.0));
    }

    #[test]
    fn parse_number_pattern_case_6() {
        assert_eq!(parse_number_pattern("enam"), Some(6.0));
    }

    #[test]
    fn parse_number_pattern_case_7() {
        assert_eq!(parse_number_pattern("3 jam"), Some(3.0));
    }

    #[test]
    fn parse_number_pattern_case_8() {
        assert_eq!(parse_number_pattern("500 SM"), Some(500.0));
    }

    #[test]
    fn year_pattern_matches_upstream() {
        assert_eq!(
            YEAR_PATTERN,
            r"(?:[1-9][0-9]{0,3}\s*(?:SM|M)(?=\W|$)|[1-2][0-9]{3}|[5-9][0-9])"
        );
    }

    #[test]
    fn parse_year_case_1() {
        assert_eq!(parse_year("1"), Some(2001));
    }

    #[test]
    fn parse_year_case_2() {
        assert_eq!(parse_year("ags"), None);
    }

    #[test]
    fn parse_year_case_3() {
        assert_eq!(parse_year("2"), Some(2002));
    }

    #[test]
    fn parse_year_case_4() {
        assert_eq!(parse_year("3"), Some(2003));
    }

    #[test]
    fn parse_year_case_5() {
        assert_eq!(parse_year("3 jam"), Some(3));
    }

    #[test]
    fn parse_year_case_6() {
        assert_eq!(parse_year("500 SM"), Some(-500));
    }

    #[test]
    fn parse_year_case_7() {
        assert_eq!(parse_year("3 hari "), Some(2003));
    }

    #[test]
    fn time_units_pattern_matches_upstream() {
        let want = r"(?:(?:(?:(?:dua belas|sembilan|delapan|sepuluh|sebelas|empat|tujuh|satu|tiga|lima|enam|dua)|[0-9]+|[0-9]+[\.,][0-9]+|setengah))\s{0,5}|se)(?:(?:minggu|detik|menit|pekan|bulan|tahun|hari|jam))\s{0,5}(?:\s{0,5}(?:,|dan)?\s{0,5}(?:(?:(?:(?:dua belas|sembilan|delapan|sepuluh|sebelas|empat|tujuh|satu|tiga|lima|enam|dua)|[0-9]+|[0-9]+[\.,][0-9]+|setengah))\s{0,5}|se)(?:(?:minggu|detik|menit|pekan|bulan|tahun|hari|jam))\s{0,5}){0,10}";
        assert_eq!(*TIME_UNITS_PATTERN, want);
    }

    #[test]
    fn parse_duration_case_1() {
        assert_eq!(parse_duration("1"), Duration::from_pairs(&[]));
    }

    #[test]
    fn parse_duration_case_2() {
        assert_eq!(parse_duration("3 jam"), Duration::from_pairs(&[(Hour, 3.0)]));
    }

    #[test]
    fn parse_duration_case_3() {
        assert_eq!(parse_duration("3 hari "), Duration::from_pairs(&[(Day, 3.0)]));
    }

    #[test]
    fn parse_duration_case_4() {
        assert_eq!(parse_duration("5 hari "), Duration::from_pairs(&[(Day, 5.0)]));
    }

    #[test]
    fn parse_duration_case_5() {
        assert_eq!(parse_duration("sebulan"), Duration::from_pairs(&[(Month, 1.0)]));
    }

    #[test]
    fn parse_duration_case_6() {
        assert_eq!(parse_duration("setahun "), Duration::from_pairs(&[(Year, 1.0)]));
    }

    #[test]
    fn parse_duration_case_7() {
        assert_eq!(parse_duration("seminggu "), Duration::from_pairs(&[(Week, 1.0)]));
    }
}
