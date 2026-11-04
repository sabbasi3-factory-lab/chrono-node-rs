//! upstream `locales/fi/constants.ts`. Ported in full so parser tasks don't edit this file.
//!
//! Dictionaries are `(key, value)` slices **in upstream's key order**. It matters:
//! `match_any_pattern` sorts stably, so equal-length keys keep this order.

use std::sync::LazyLock;

use crate::calculation::duration::{Duration, DurationUnit};
use crate::calculation::years::find_most_likely_ad_year;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::js::{js_parse_int, js_substring_from};
use crate::core::utils::pattern::{
    dict_get, dict_keys, js_len, match_any_pattern, repeated_timeunit_pattern, Dictionary,
};
use crate::js_regex;

pub static WEEKDAY_DICTIONARY: &Dictionary<i64> = &[
    ("sunnuntai", 0),
    ("sunnuntaina", 0),
    ("su", 0),
    ("maanantai", 1),
    ("maanantaina", 1),
    ("ma", 1),
    ("tiistai", 2),
    ("tiistaina", 2),
    ("ti", 2),
    ("keskiviikko", 3),
    ("keskiviikkona", 3),
    ("ke", 3),
    ("torstai", 4),
    ("torstaina", 4),
    ("to", 4),
    ("perjantai", 5),
    ("perjantaina", 5),
    ("pe", 5),
    ("lauantai", 6),
    ("lauantaina", 6),
    ("la", 6),
];

pub static MONTH_DICTIONARY: &Dictionary<i64> = &[
    ("tammikuu", 1),
    ("tammikuuta", 1),
    ("tammikuun", 1),
    ("tammi", 1),
    ("helmikuu", 2),
    ("helmikuuta", 2),
    ("helmikuun", 2),
    ("helmi", 2),
    ("maaliskuu", 3),
    ("maaliskuuta", 3),
    ("maaliskuun", 3),
    ("maalis", 3),
    ("huhtikuu", 4),
    ("huhtikuuta", 4),
    ("huhtikuun", 4),
    ("huhti", 4),
    ("toukokuu", 5),
    ("toukokuuta", 5),
    ("toukokuun", 5),
    ("touko", 5),
    ("kesäkuu", 6),
    ("kesäkuuta", 6),
    ("kesäkuun", 6),
    ("kesä", 6),
    ("heinäkuu", 7),
    ("heinäkuuta", 7),
    ("heinäkuun", 7),
    ("heinä", 7),
    ("elokuu", 8),
    ("elokuuta", 8),
    ("elokuun", 8),
    ("elo", 8),
    ("syyskuu", 9),
    ("syyskuuta", 9),
    ("syyskuun", 9),
    ("syys", 9),
    ("lokakuu", 10),
    ("lokakuuta", 10),
    ("lokakuun", 10),
    ("loka", 10),
    ("marraskuu", 11),
    ("marraskuuta", 11),
    ("marraskuun", 11),
    ("marras", 11),
    ("joulukuu", 12),
    ("joulukuuta", 12),
    ("joulukuun", 12),
    ("joulu", 12),
];

pub static INTEGER_WORD_DICTIONARY: &Dictionary<i64> = &[
    ("yksi", 1),
    ("yhden", 1),
    ("kaksi", 2),
    ("kahden", 2),
    ("kolme", 3),
    ("kolmen", 3),
    ("neljä", 4),
    ("neljän", 4),
    ("viisi", 5),
    ("viiden", 5),
    ("kuusi", 6),
    ("kuuden", 6),
    ("seitsemän", 7),
    ("kahdeksan", 8),
    ("yhdeksän", 9),
    ("kymmenen", 10),
];

pub static TIME_UNIT_DICTIONARY: &Dictionary<DurationUnit> = &[
    ("s", DurationUnit::Second),
    ("sek", DurationUnit::Second),
    ("sekunti", DurationUnit::Second),
    ("sekuntia", DurationUnit::Second),
    ("sekunnin", DurationUnit::Second),
    ("min", DurationUnit::Minute),
    ("minuutti", DurationUnit::Minute),
    ("minuuttia", DurationUnit::Minute),
    ("minuutin", DurationUnit::Minute),
    ("t", DurationUnit::Hour),
    ("tunti", DurationUnit::Hour),
    ("tuntia", DurationUnit::Hour),
    ("tunnin", DurationUnit::Hour),
    ("pv", DurationUnit::Day),
    ("päivä", DurationUnit::Day),
    ("päivää", DurationUnit::Day),
    ("päivän", DurationUnit::Day),
    ("vk", DurationUnit::Week),
    ("viikko", DurationUnit::Week),
    ("viikkoa", DurationUnit::Week),
    ("viikon", DurationUnit::Week),
    ("kk", DurationUnit::Month),
    ("kuukausi", DurationUnit::Month),
    ("kuukautta", DurationUnit::Month),
    ("kuukauden", DurationUnit::Month),
    ("vuosi", DurationUnit::Year),
    ("vuotta", DurationUnit::Year),
    ("vuoden", DurationUnit::Year),
];

pub static TIME_UNIT_NO_ABBR_DICTIONARY: &Dictionary<DurationUnit> = &[
    ("sekunti", DurationUnit::Second),
    ("sekuntia", DurationUnit::Second),
    ("sekunnin", DurationUnit::Second),
    ("minuutti", DurationUnit::Minute),
    ("minuuttia", DurationUnit::Minute),
    ("minuutin", DurationUnit::Minute),
    ("tunti", DurationUnit::Hour),
    ("tuntia", DurationUnit::Hour),
    ("tunnin", DurationUnit::Hour),
    ("päivä", DurationUnit::Day),
    ("päivää", DurationUnit::Day),
    ("päivän", DurationUnit::Day),
    ("viikko", DurationUnit::Week),
    ("viikkoa", DurationUnit::Week),
    ("viikon", DurationUnit::Week),
    ("kuukausi", DurationUnit::Month),
    ("kuukautta", DurationUnit::Month),
    ("kuukauden", DurationUnit::Month),
    ("vuosi", DurationUnit::Year),
    ("vuotta", DurationUnit::Year),
    ("vuoden", DurationUnit::Year),
];

/// `parseDuration(timeunitText)`. Like upstream, an input with no time unit gives an empty
/// duration (`{}`), not `null`.
pub fn parse_duration(timeunit_text: &str) -> Duration {
    let mut fragments = Duration::new();
    let mut remaining = timeunit_text.to_string();
    let mut found = SINGLE_TIME_UNIT_REGEX.exec(&remaining);
    while let Some(m) = found {
        collect_date_time_fragment(&mut fragments, &m);
        // Upstream cuts `match[0].length` units from the *start*, not from the match position.
        remaining = js_substring_from(&remaining, js_len(m.text())).to_string();
        found = SINGLE_TIME_UNIT_REGEX.exec(&remaining);
    }
    fragments
}

fn collect_date_time_fragment(fragments: &mut Duration, m: &RegexMatch) {
    let num = parse_number_pattern(m.get(1).unwrap_or("")).map_or(f64::NAN, |n| n as f64);
    // The regex only matches dictionary keys, so the lookup always succeeds.
    if let Some(unit) = dict_get(TIME_UNIT_DICTIONARY, &m.get(2).unwrap_or("").to_lowercase()) {
        fragments.set(unit, num);
    }
}

pub static NUMBER_PATTERN: LazyLock<String> =
    LazyLock::new(|| format!(r"(?:{}|\d+)", match_any_pattern(dict_keys(INTEGER_WORD_DICTIONARY))));

pub static TIME_UNIT_PATTERN: LazyLock<String> =
    LazyLock::new(|| format!(r"(?:{})", match_any_pattern(dict_keys(TIME_UNIT_DICTIONARY))));

static SINGLE_TIME_UNIT_PATTERN: LazyLock<String> = LazyLock::new(|| {
    format!(
        r"({})\s{{0,5}}({})\s{{0,5}}",
        *NUMBER_PATTERN,
        match_any_pattern(dict_keys(TIME_UNIT_DICTIONARY))
    )
});

static SINGLE_TIME_UNIT_REGEX: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new(&SINGLE_TIME_UNIT_PATTERN, "i"));

static SINGLE_TIME_UNIT_NO_ABBR_PATTERN: LazyLock<String> = LazyLock::new(|| {
    format!(
        r"({})\s{{0,5}}({})\s{{0,5}}",
        *NUMBER_PATTERN,
        match_any_pattern(dict_keys(TIME_UNIT_NO_ABBR_DICTIONARY))
    )
});

pub static TIME_UNITS_PATTERN: LazyLock<String> =
    LazyLock::new(|| repeated_timeunit_pattern("", &SINGLE_TIME_UNIT_PATTERN, None));

pub static TIME_UNITS_NO_ABBR_PATTERN: LazyLock<String> =
    LazyLock::new(|| repeated_timeunit_pattern("", &SINGLE_TIME_UNIT_NO_ABBR_PATTERN, None));

/// `parseNumberPattern(match)`. `None` is `NaN`.
pub fn parse_number_pattern(m: &str) -> Option<i64> {
    let num = m.to_lowercase();
    if let Some(v) = dict_get(INTEGER_WORD_DICTIONARY, &num) {
        return Some(v);
    }
    js_parse_int(&num)
}

/// `parseYear(match)`. `None` is `NaN`.
pub fn parse_year(m: &str) -> Option<i64> {
    if js_regex!(r"\d+").is_match(m) {
        // `NaN < 100` is false, so NaN passes through unchanged.
        let year_number = js_parse_int(m)?;
        if year_number < 100 {
            return Some(find_most_likely_ad_year(year_number));
        }
        return Some(year_number);
    }

    let num = m.to_lowercase();
    if let Some(v) = dict_get(INTEGER_WORD_DICTIONARY, &num) {
        return Some(v);
    }

    js_parse_int(m)
}

#[cfg(test)]
mod tests {
    use super::*;
    use DurationUnit::*;

    fn check_map<V: PartialEq + std::fmt::Debug + Copy>(actual: &Dictionary<V>, expect: &[(&str, V)]) {
        assert_eq!(actual.len(), expect.len());
        for (a, e) in actual.iter().zip(expect) {
            assert_eq!(a.0, e.0);
            assert_eq!(a.1, e.1);
        }
    }

    fn dur(pairs: &[(DurationUnit, f64)]) -> Duration {
        Duration::from_pairs(pairs)
    }

    #[test]
    fn weekday_dictionary_matches_upstream() {
        check_map(
            WEEKDAY_DICTIONARY,
            &[
                ("sunnuntai", 0),
                ("sunnuntaina", 0),
                ("su", 0),
                ("maanantai", 1),
                ("maanantaina", 1),
                ("ma", 1),
                ("tiistai", 2),
                ("tiistaina", 2),
                ("ti", 2),
                ("keskiviikko", 3),
                ("keskiviikkona", 3),
                ("ke", 3),
                ("torstai", 4),
                ("torstaina", 4),
                ("to", 4),
                ("perjantai", 5),
                ("perjantaina", 5),
                ("pe", 5),
                ("lauantai", 6),
                ("lauantaina", 6),
                ("la", 6),
            ],
        );
    }

    #[test]
    fn month_dictionary_matches_upstream() {
        let names = [
            ("tammi", 1),
            ("helmi", 2),
            ("maalis", 3),
            ("huhti", 4),
            ("touko", 5),
            ("kesä", 6),
            ("heinä", 7),
            ("elo", 8),
            ("syys", 9),
            ("loka", 10),
            ("marras", 11),
            ("joulu", 12),
        ];
        assert_eq!(MONTH_DICTIONARY.len(), 48);
        for (i, (stem, n)) in names.iter().enumerate() {
            // Each month lists: <stem>kuu, <stem>kuuta, <stem>kuun, <stem>.
            let full = format!("{stem}kuu");
            let expected = [full.clone(), format!("{full}ta"), format!("{full}n"), stem.to_string()];
            for (g, e) in MONTH_DICTIONARY[i * 4..i * 4 + 4].iter().zip(&expected) {
                assert_eq!(g.0, e);
                assert_eq!(g.1, *n);
            }
        }
    }

    #[test]
    fn integer_word_dictionary_matches_upstream() {
        check_map(
            INTEGER_WORD_DICTIONARY,
            &[
                ("yksi", 1),
                ("yhden", 1),
                ("kaksi", 2),
                ("kahden", 2),
                ("kolme", 3),
                ("kolmen", 3),
                ("neljä", 4),
                ("neljän", 4),
                ("viisi", 5),
                ("viiden", 5),
                ("kuusi", 6),
                ("kuuden", 6),
                ("seitsemän", 7),
                ("kahdeksan", 8),
                ("yhdeksän", 9),
                ("kymmenen", 10),
            ],
        );
    }

    #[test]
    fn time_unit_dictionary_matches_upstream() {
        check_map(
            TIME_UNIT_DICTIONARY,
            &[
                ("s", Second),
                ("sek", Second),
                ("sekunti", Second),
                ("sekuntia", Second),
                ("sekunnin", Second),
                ("min", Minute),
                ("minuutti", Minute),
                ("minuuttia", Minute),
                ("minuutin", Minute),
                ("t", Hour),
                ("tunti", Hour),
                ("tuntia", Hour),
                ("tunnin", Hour),
                ("pv", Day),
                ("päivä", Day),
                ("päivää", Day),
                ("päivän", Day),
                ("vk", Week),
                ("viikko", Week),
                ("viikkoa", Week),
                ("viikon", Week),
                ("kk", Month),
                ("kuukausi", Month),
                ("kuukautta", Month),
                ("kuukauden", Month),
                ("vuosi", Year),
                ("vuotta", Year),
                ("vuoden", Year),
            ],
        );
    }

    #[test]
    fn time_unit_no_abbr_dictionary_matches_upstream() {
        check_map(
            TIME_UNIT_NO_ABBR_DICTIONARY,
            &[
                ("sekunti", Second),
                ("sekuntia", Second),
                ("sekunnin", Second),
                ("minuutti", Minute),
                ("minuuttia", Minute),
                ("minuutin", Minute),
                ("tunti", Hour),
                ("tuntia", Hour),
                ("tunnin", Hour),
                ("päivä", Day),
                ("päivää", Day),
                ("päivän", Day),
                ("viikko", Week),
                ("viikkoa", Week),
                ("viikon", Week),
                ("kuukausi", Month),
                ("kuukautta", Month),
                ("kuukauden", Month),
                ("vuosi", Year),
                ("vuotta", Year),
                ("vuoden", Year),
            ],
        );
    }

    #[test]
    fn parse_duration_case_1() {
        assert_eq!(parse_duration("1"), Duration::new());
    }

    #[test]
    fn parse_duration_case_2() {
        assert_eq!(parse_duration("3 t"), dur(&[(Hour, 3.0)]));
    }

    #[test]
    fn parse_duration_case_3() {
        assert_eq!(parse_duration("15min"), dur(&[(Minute, 15.0)]));
    }

    #[test]
    fn parse_duration_case_4() {
        assert_eq!(parse_duration("3vuotta"), dur(&[(Year, 3.0)]));
    }

    #[test]
    fn parse_duration_case_5() {
        assert_eq!(parse_duration("yksi vuotta"), dur(&[(Year, 1.0)]));
    }

    #[test]
    fn parse_duration_case_6() {
        assert_eq!(parse_duration("kaksi vuotta"), dur(&[(Year, 2.0)]));
    }

    #[test]
    fn parse_duration_case_7() {
        assert_eq!(parse_duration("kaksi viikkoa"), dur(&[(Week, 2.0)]));
    }

    const NUMBER: &str = r"(?:(?:seitsemän|kahdeksan|yhdeksän|kymmenen|kahden|kolmen|neljän|viiden|kuuden|yhden|kaksi|kolme|neljä|viisi|kuusi|yksi)|\d+)";
    const UNITS: &str = r"(?:(?:minuuttia|kuukautta|kuukauden|sekuntia|sekunnin|minuutti|minuutin|kuukausi|sekunti|viikkoa|tuntia|tunnin|päivää|päivän|viikko|viikon|vuotta|vuoden|tunti|päivä|vuosi|sek|min|pv|vk|kk|s|t))";
    const UNITS_NO_ABBR: &str = r"(?:(?:minuuttia|kuukautta|kuukauden|sekuntia|sekunnin|minuutti|minuutin|kuukausi|sekunti|viikkoa|tuntia|tunnin|päivää|päivän|viikko|viikon|vuotta|vuoden|tunti|päivä|vuosi))";

    #[test]
    fn number_pattern_matches_upstream() {
        assert_eq!(*NUMBER_PATTERN, NUMBER);
    }

    #[test]
    fn time_unit_pattern_matches_upstream() {
        assert_eq!(*TIME_UNIT_PATTERN, UNITS);
    }

    #[test]
    fn time_units_pattern_matches_upstream() {
        let single = format!(r"(?:{NUMBER})\s{{0,5}}{UNITS}\s{{0,5}}");
        assert_eq!(
            *TIME_UNITS_PATTERN,
            format!(r"{single}(?:\s{{0,5}},?\s{{0,5}}{single}){{0,10}}")
        );
    }

    #[test]
    fn time_units_no_abbr_pattern_matches_upstream() {
        let single = format!(r"(?:{NUMBER})\s{{0,5}}{UNITS_NO_ABBR}\s{{0,5}}");
        assert_eq!(
            *TIME_UNITS_NO_ABBR_PATTERN,
            format!(r"{single}(?:\s{{0,5}},?\s{{0,5}}{single}){{0,10}}")
        );
    }

    #[test]
    fn parse_number_pattern_case_1() {
        assert_eq!(parse_number_pattern("1"), Some(1));
    }

    #[test]
    fn parse_number_pattern_case_2() {
        assert_eq!(parse_number_pattern("s"), None);
    }

    #[test]
    fn parse_number_pattern_case_3() {
        assert_eq!(parse_number_pattern("2"), Some(2));
    }

    #[test]
    fn parse_number_pattern_case_4() {
        assert_eq!(parse_number_pattern("3"), Some(3));
    }

    #[test]
    fn parse_number_pattern_case_5() {
        assert_eq!(parse_number_pattern("3 t"), Some(3));
    }

    #[test]
    fn parse_number_pattern_case_6() {
        assert_eq!(parse_number_pattern("yksi"), Some(1));
    }

    #[test]
    fn parse_number_pattern_case_7() {
        assert_eq!(parse_number_pattern("15min"), Some(15));
    }

    #[test]
    fn parse_number_pattern_case_8() {
        assert_eq!(parse_number_pattern("kaksi"), Some(2));
    }

    #[test]
    fn parse_year_case_1() {
        assert_eq!(parse_year("1"), Some(2001));
    }

    #[test]
    fn parse_year_case_2() {
        assert_eq!(parse_year("s"), None);
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
        assert_eq!(parse_year("3 t"), Some(2003));
    }

    #[test]
    fn parse_year_case_6() {
        assert_eq!(parse_year("yksi"), Some(1));
    }

    #[test]
    fn parse_year_case_7() {
        assert_eq!(parse_year("15min"), Some(2015));
    }

    #[test]
    fn parse_year_case_8() {
        assert_eq!(parse_year("kaksi"), Some(2));
    }
}
