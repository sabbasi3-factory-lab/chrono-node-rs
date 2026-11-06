//! upstream `locales/uk/constants.ts`. Ported in full so parser tasks don't edit this file.
//!
//! Dictionaries are `(key, value)` slices **in upstream's key order**. It matters:
//! `match_any_pattern` sorts stably, so equal-length keys keep this order.

use std::sync::LazyLock;

use crate::calculation::duration::{Duration, DurationUnit};
use crate::calculation::years::find_most_likely_ad_year;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::js::{js_parse_float, js_parse_int, js_substring_from, js_trim};
use crate::core::utils::pattern::{
    dict_get, dict_keys, js_len, match_any_pattern, repeated_timeunit_pattern, Dictionary,
};
use crate::js_regex;

pub const LEFT_BOUNDARY: &str = r"([^\p{L}\p{N}_]|^)";
pub const RIGHT_BOUNDARY: &str = r"(?=[^\p{L}\p{N}_]|$)";
pub const FLAGS: &str = "iu";

pub static WEEKDAY_DICTIONARY: &Dictionary<i64> = &[
    ("неділя", 0),
    ("неділі", 0),
    ("неділю", 0),
    ("нд", 0),
    ("нд.", 0),
    ("понеділок", 1),
    ("понеділка", 1),
    ("пн", 1),
    ("пн.", 1),
    ("вівторок", 2),
    ("вівторка", 2),
    ("вт", 2),
    ("вт.", 2),
    ("середа", 3),
    ("середи", 3),
    ("середу", 3),
    ("ср", 3),
    ("ср.", 3),
    ("четвер", 4),
    ("четверга", 4),
    ("четвергу", 4),
    ("чт", 4),
    ("чт.", 4),
    ("п'ятниця", 5),
    ("п'ятниці", 5),
    ("п'ятницю", 5),
    ("пт", 5),
    ("пт.", 5),
    ("субота", 6),
    ("суботи", 6),
    ("суботу", 6),
    ("сб", 6),
    ("сб.", 6),
];

pub static FULL_MONTH_NAME_DICTIONARY: &Dictionary<i64> = &[
    ("січень", 1),
    ("січня", 1),
    ("січні", 1),
    ("лютий", 2),
    ("лютого", 2),
    ("лютому", 2),
    ("березень", 3),
    ("березня", 3),
    ("березні", 3),
    ("квітень", 4),
    ("квітня", 4),
    ("квітні", 4),
    ("травень", 5),
    ("травня", 5),
    ("травні", 5),
    ("червень", 6),
    ("червня", 6),
    ("червні", 6),
    ("липень", 7),
    ("липня", 7),
    ("липні", 7),
    ("серпень", 8),
    ("серпня", 8),
    ("серпні", 8),
    ("вересень", 9),
    ("вересня", 9),
    ("вересні", 9),
    ("жовтень", 10),
    ("жовтня", 10),
    ("жовтні", 10),
    ("листопад", 11),
    ("листопада", 11),
    ("листопаду", 11),
    ("грудень", 12),
    ("грудня", 12),
    ("грудні", 12),
];

/// `{ ...FULL_MONTH_NAME_DICTIONARY, ... }`: the spread keys come first.
/// `"cер."` starts with a Latin `c`, byte for byte as upstream.
pub static MONTH_DICTIONARY: &Dictionary<i64> = &[
    ("січень", 1),
    ("січня", 1),
    ("січні", 1),
    ("лютий", 2),
    ("лютого", 2),
    ("лютому", 2),
    ("березень", 3),
    ("березня", 3),
    ("березні", 3),
    ("квітень", 4),
    ("квітня", 4),
    ("квітні", 4),
    ("травень", 5),
    ("травня", 5),
    ("травні", 5),
    ("червень", 6),
    ("червня", 6),
    ("червні", 6),
    ("липень", 7),
    ("липня", 7),
    ("липні", 7),
    ("серпень", 8),
    ("серпня", 8),
    ("серпні", 8),
    ("вересень", 9),
    ("вересня", 9),
    ("вересні", 9),
    ("жовтень", 10),
    ("жовтня", 10),
    ("жовтні", 10),
    ("листопад", 11),
    ("листопада", 11),
    ("листопаду", 11),
    ("грудень", 12),
    ("грудня", 12),
    ("грудні", 12),
    ("січ", 1),
    ("січ.", 1),
    ("лют", 2),
    ("лют.", 2),
    ("бер", 3),
    ("бер.", 3),
    ("квіт", 4),
    ("квіт.", 4),
    ("трав", 5),
    ("трав.", 5),
    ("черв", 6),
    ("черв.", 6),
    ("лип", 7),
    ("лип.", 7),
    ("серп", 8),
    ("серп.", 8),
    ("сер", 8),
    ("cер.", 8),
    ("вер", 9),
    ("вер.", 9),
    ("верес", 9),
    ("верес.", 9),
    ("жовт", 10),
    ("жовт.", 10),
    ("листоп", 11),
    ("листоп.", 11),
    ("груд", 12),
    ("груд.", 12),
];

pub static INTEGER_WORD_DICTIONARY: &Dictionary<i64> = &[
    ("один", 1),
    ("одна", 1),
    ("одної", 1),
    ("одну", 1),
    ("дві", 2),
    ("два", 2),
    ("двох", 2),
    ("три", 3),
    ("трьох", 3),
    ("чотири", 4),
    ("чотирьох", 4),
    ("п'ять", 5),
    ("п'яти", 5),
    ("шість", 6),
    ("шести", 6),
    ("сім", 7),
    ("семи", 7),
    ("вісім", 8),
    ("восьми", 8),
    ("дев'ять", 9),
    ("дев'яти", 9),
    ("десять", 10),
    ("десяти", 10),
    ("одинадцять", 11),
    ("одинадцяти", 11),
    ("дванадцять", 12),
    ("дванадцяти", 12),
];

pub static ORDINAL_WORD_DICTIONARY: &Dictionary<i64> = &[
    ("перше", 1),
    ("першого", 1),
    ("друге", 2),
    ("другого", 2),
    ("третє", 3),
    ("третього", 3),
    ("четверте", 4),
    ("четвертого", 4),
    ("п'яте", 5),
    ("п'ятого", 5),
    ("шосте", 6),
    ("шостого", 6),
    ("сьоме", 7),
    ("сьомого", 7),
    ("восьме", 8),
    ("восьмого", 8),
    ("дев'яте", 9),
    ("дев'ятого", 9),
    ("десяте", 10),
    ("десятого", 10),
    ("одинадцяте", 11),
    ("одинадцятого", 11),
    ("дванадцяте", 12),
    ("дванадцятого", 12),
    ("тринадцяте", 13),
    ("тринадцятого", 13),
    ("чотирнадцяте", 14),
    ("чотинрнадцятого", 14),
    ("п'ятнадцяте", 15),
    ("п'ятнадцятого", 15),
    ("шістнадцяте", 16),
    ("шістнадцятого", 16),
    ("сімнадцяте", 17),
    ("сімнадцятого", 17),
    ("вісімнадцяте", 18),
    ("вісімнадцятого", 18),
    ("дев'ятнадцяте", 19),
    ("дев'ятнадцятого", 19),
    ("двадцяте", 20),
    ("двадцятого", 20),
    ("двадцять перше", 21),
    ("двадцять першого", 21),
    ("двадцять друге", 22),
    ("двадцять другого", 22),
    ("двадцять третє", 23),
    ("двадцять третього", 23),
    ("двадцять четверте", 24),
    ("двадцять четвертого", 24),
    ("двадцять п'яте", 25),
    ("двадцять п'ятого", 25),
    ("двадцять шосте", 26),
    ("двадцять шостого", 26),
    ("двадцять сьоме", 27),
    ("двадцять сьомого", 27),
    ("двадцять восьме", 28),
    ("двадцять восьмого", 28),
    ("двадцять дев'яте", 29),
    ("двадцять дев'ятого", 29),
    ("тридцяте", 30),
    ("тридцятого", 30),
    ("тридцять перше", 31),
    ("тридцять першого", 31),
];

pub static TIME_UNIT_DICTIONARY: &Dictionary<DurationUnit> = &[
    ("сек", DurationUnit::Second),
    ("секунда", DurationUnit::Second),
    ("секунд", DurationUnit::Second),
    ("секунди", DurationUnit::Second),
    ("секунду", DurationUnit::Second),
    ("секундочок", DurationUnit::Second),
    ("секундочки", DurationUnit::Second),
    ("секундочку", DurationUnit::Second),
    ("хв", DurationUnit::Minute),
    ("хвилина", DurationUnit::Minute),
    ("хвилин", DurationUnit::Minute),
    ("хвилини", DurationUnit::Minute),
    ("хвилину", DurationUnit::Minute),
    ("хвилинок", DurationUnit::Minute),
    ("хвилинки", DurationUnit::Minute),
    ("хвилинку", DurationUnit::Minute),
    ("хвилиночок", DurationUnit::Minute),
    ("хвилиночки", DurationUnit::Minute),
    ("хвилиночку", DurationUnit::Minute),
    ("год", DurationUnit::Hour),
    ("година", DurationUnit::Hour),
    ("годин", DurationUnit::Hour),
    ("години", DurationUnit::Hour),
    ("годину", DurationUnit::Hour),
    ("годинка", DurationUnit::Hour),
    ("годинок", DurationUnit::Hour),
    ("годинки", DurationUnit::Hour),
    ("годинку", DurationUnit::Hour),
    ("день", DurationUnit::Day),
    ("дня", DurationUnit::Day),
    ("днів", DurationUnit::Day),
    ("дні", DurationUnit::Day),
    ("доба", DurationUnit::Day),
    ("добу", DurationUnit::Day),
    ("тиждень", DurationUnit::Week),
    ("тижню", DurationUnit::Week),
    ("тижня", DurationUnit::Week),
    ("тижні", DurationUnit::Week),
    ("тижнів", DurationUnit::Week),
    ("місяць", DurationUnit::Month),
    ("місяців", DurationUnit::Month),
    ("місяці", DurationUnit::Month),
    ("місяця", DurationUnit::Month),
    ("квартал", DurationUnit::Quarter),
    ("кварталу", DurationUnit::Quarter),
    ("квартала", DurationUnit::Quarter),
    ("кварталів", DurationUnit::Quarter),
    ("кварталі", DurationUnit::Quarter),
    ("рік", DurationUnit::Year),
    ("року", DurationUnit::Year),
    ("році", DurationUnit::Year),
    ("років", DurationUnit::Year),
    ("роки", DurationUnit::Year),
];

//-----------------------------

pub static NUMBER_PATTERN: LazyLock<String> = LazyLock::new(|| {
    format!(
        r"(?:{}|[0-9]+|[0-9]+\.[0-9]+|пів|декілька|пар(?:у)|\s{{0,3}})",
        match_any_pattern(dict_keys(INTEGER_WORD_DICTIONARY))
    )
});

/// `parseNumberPattern(match)`. May be fractional (`пів` = 0.5) or `NaN`.
pub fn parse_number_pattern(m: &str) -> f64 {
    let num = m.to_lowercase();
    if let Some(v) = dict_get(INTEGER_WORD_DICTIONARY, &num) {
        return v as f64;
    }
    if num.contains("декілька") {
        return 2.0;
    } else if num.contains("пів") {
        return 0.5;
    } else if num.contains("пар") {
        return 2.0;
    } else if num.is_empty() {
        return 1.0;
    }
    js_parse_float(&num)
}

//-----------------------------

pub static ORDINAL_NUMBER_PATTERN: LazyLock<String> = LazyLock::new(|| {
    format!(
        r"(?:{}|[0-9]{{1,2}}(?:го|ого|е)?)",
        match_any_pattern(dict_keys(ORDINAL_WORD_DICTIONARY))
    )
});

/// `parseOrdinalNumberPattern(match)`. `None` is `NaN`.
pub fn parse_ordinal_number_pattern(m: &str) -> Option<i64> {
    let num = m.to_lowercase();
    if let Some(v) = dict_get(ORDINAL_WORD_DICTIONARY, &num) {
        return Some(v);
    }
    js_parse_int(&num)
}

//-----------------------------

// Upstream's `year` helper: `(?:\s+(?:року|рік|р|р.))?`.
macro_rules! year_suffix {
    () => {
        r"(?:\s+(?:року|рік|р|р.))?"
    };
}

pub const YEAR_PATTERN: &str = concat!(
    r"(?:[1-9][0-9]{0,3}",
    year_suffix!(),
    r"\s*(?:н.е.|до н.е.|н. е.|до н. е.)|[1-2][0-9]{3}",
    year_suffix!(),
    "|[5-9][0-9]",
    year_suffix!(),
    ")"
);

/// `match.replace(regex, "")` for a non-global regex: removes the first match only.
fn replace_first(text: &str, m: Option<RegexMatch>) -> String {
    match m {
        Some(m) => format!("{}{}", &text[..m.index], &text[m.index + m.text().len()..]),
        None => text.to_string(),
    }
}

/// `parseYearPattern(match)`. `None` is `NaN`.
pub fn parse_year_pattern(m: &str) -> Option<i64> {
    let mut m = m.to_string();
    let era_word = js_regex!(r"(рік|року|р|р.)", "i");
    if era_word.is_match(&m) {
        m = replace_first(&m, era_word.exec(&m));
    }

    let bce = js_regex!(r"(до н.е.|до н. е.)", "i");
    if bce.is_match(&m) {
        // Before Common Era
        return js_parse_int(&replace_first(&m, bce.exec(&m))).map(|y| -y);
    }

    let ce = js_regex!(r"(н. е.|н.е.)", "i");
    if ce.is_match(&m) {
        // Common Era
        return js_parse_int(&replace_first(&m, ce.exec(&m)));
    }

    js_parse_int(&m).map(find_most_likely_ad_year)
}

//-----------------------------

static SINGLE_TIME_UNIT_PATTERN: LazyLock<String> = LazyLock::new(|| {
    format!(
        r"({})\s{{0,3}}({})",
        *NUMBER_PATTERN,
        match_any_pattern(dict_keys(TIME_UNIT_DICTIONARY))
    )
});

static SINGLE_TIME_UNIT_REGEX: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new(&SINGLE_TIME_UNIT_PATTERN, "i"));

pub static TIME_UNITS_PATTERN: LazyLock<String> =
    LazyLock::new(|| repeated_timeunit_pattern(r"(?:(?:близько|приблизно)\s{0,3})?", &SINGLE_TIME_UNIT_PATTERN, None));

/// `parseDuration(timeunitText)`. An input with no time unit gives an empty duration (`{}`).
pub fn parse_duration(timeunit_text: &str) -> Duration {
    let mut fragments = Duration::new();
    let mut remaining = timeunit_text.to_string();
    let mut found = SINGLE_TIME_UNIT_REGEX.exec(&remaining);
    while let Some(m) = found {
        collect_date_time_fragment(&mut fragments, &m);
        // Upstream cuts `match[0].length` units from the *start*, not from the match position.
        remaining = js_trim(js_substring_from(&remaining, js_len(m.text()))).to_string();
        found = SINGLE_TIME_UNIT_REGEX.exec(&remaining);
    }
    fragments
}

fn collect_date_time_fragment(fragments: &mut Duration, m: &RegexMatch) {
    let num = parse_number_pattern(m.get(1).unwrap_or(""));
    // The regex only matches dictionary keys, so the lookup always succeeds.
    if let Some(unit) = dict_get(TIME_UNIT_DICTIONARY, &m.get(2).unwrap_or("").to_lowercase()) {
        fragments.set(unit, num);
    }
}

#[cfg(test)]
mod tests {
    //! Expected values were produced by chrono-node v2.10.3 itself (compiled from `upstream/`).
    use super::*;

    fn dict_eq<V: Copy + PartialEq + std::fmt::Debug>(d: &Dictionary<V>, n: usize, last: (&str, V)) {
        assert_eq!(d.len(), n);
        assert_eq!(d[n - 1], last);
        let mut keys: Vec<&str> = dict_keys(d).collect();
        keys.sort_unstable();
        keys.dedup();
        assert_eq!(keys.len(), n);
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
        for (u, v) in expect {
            assert_eq!(d.get(*u), Some(*v));
        }
    }

    #[test]
    fn regex_parts_matches_upstream() {
        assert_eq!(LEFT_BOUNDARY, r"([^\p{L}\p{N}_]|^)");
        assert_eq!(RIGHT_BOUNDARY, r"(?=[^\p{L}\p{N}_]|$)");
        assert_eq!(FLAGS, "iu");
    }

    #[test]
    fn weekday_dictionary_matches_upstream() {
        dict_eq(WEEKDAY_DICTIONARY, 33, ("сб.", 6));
        assert_eq!(dict_get(WEEKDAY_DICTIONARY, "середу"), Some(3));
        assert_eq!(dict_get(WEEKDAY_DICTIONARY, "п'ятницю"), Some(5));
    }

    #[test]
    fn full_month_name_dictionary_matches_upstream() {
        dict_eq(FULL_MONTH_NAME_DICTIONARY, 36, ("грудні", 12));
    }

    #[test]
    fn month_dictionary_matches_upstream() {
        dict_eq(MONTH_DICTIONARY, 64, ("груд.", 12));
        assert_eq!(dict_get(MONTH_DICTIONARY, "c\u{435}р."), Some(8));
        assert_eq!(dict_get(MONTH_DICTIONARY, "\u{441}\u{435}р."), None);
    }

    #[test]
    fn integer_word_dictionary_matches_upstream() {
        dict_eq(INTEGER_WORD_DICTIONARY, 27, ("дванадцяти", 12));
    }

    #[test]
    fn ordinal_word_dictionary_matches_upstream() {
        dict_eq(ORDINAL_WORD_DICTIONARY, 62, ("тридцять першого", 31));
        assert_eq!(dict_get(ORDINAL_WORD_DICTIONARY, "чотинрнадцятого"), Some(14));
    }

    #[test]
    fn time_unit_dictionary_matches_upstream() {
        dict_eq(TIME_UNIT_DICTIONARY, 53, ("роки", DurationUnit::Year));
        assert_eq!(dict_get(TIME_UNIT_DICTIONARY, "хв"), Some(DurationUnit::Minute));
    }

    #[test]
    fn number_pattern_matches_upstream() {
        assert_eq!(
            *NUMBER_PATTERN,
            "(?:(?:одинадцять|одинадцяти|дванадцять|дванадцяти|чотирьох|дев'ять|дев'яти|чотири|восьми|десять|десяти|одної|трьох|п'ять|п'яти|шість|шести|вісім|один|одна|одну|двох|семи|дві|два|три|сім)|[0-9]+|[0-9]+\\.[0-9]+|пів|декілька|пар(?:у)|\\s{0,3})"
        );
    }

    #[test]
    fn parse_number_pattern_case_1() {
        num("0", Some(0.0));
    }
    #[test]
    fn parse_number_pattern_case_2() {
        num("вт", None);
    }
    #[test]
    fn parse_number_pattern_case_3() {
        num("1", Some(1.0));
    }
    #[test]
    fn parse_number_pattern_case_4() {
        num("2", Some(2.0));
    }
    #[test]
    fn parse_number_pattern_case_5() {
        num("два", Some(2.0));
    }
    #[test]
    fn parse_number_pattern_case_6() {
        num("сім", Some(7.0));
    }
    #[test]
    fn parse_number_pattern_case_7() {
        num("15хв", Some(15.0));
    }
    #[test]
    fn parse_number_pattern_case_8() {
        num("24го", Some(24.0));
    }

    #[test]
    fn ordinal_number_pattern_matches_upstream() {
        assert_eq!(
            *ORDINAL_NUMBER_PATTERN,
            "(?:(?:двадцять четвертого|двадцять дев'ятого|двадцять третього|двадцять четверте|двадцять восьмого|двадцять першого|двадцять другого|двадцять п'ятого|двадцять шостого|двадцять сьомого|двадцять дев'яте|тридцять першого|чотинрнадцятого|дев'ятнадцятого|двадцять восьме|вісімнадцятого|двадцять перше|двадцять друге|двадцять третє|двадцять п'яте|двадцять шосте|двадцять сьоме|тридцять перше|п'ятнадцятого|шістнадцятого|дев'ятнадцяте|одинадцятого|дванадцятого|тринадцятого|чотирнадцяте|сімнадцятого|вісімнадцяте|п'ятнадцяте|шістнадцяте|четвертого|одинадцяте|дванадцяте|тринадцяте|сімнадцяте|двадцятого|тридцятого|дев'ятого|третього|четверте|восьмого|десятого|двадцяте|тридцяте|першого|другого|п'ятого|шостого|сьомого|дев'яте|восьме|десяте|перше|друге|третє|п'яте|шосте|сьоме)|[0-9]{1,2}(?:го|ого|е)?)"
        );
    }

    #[test]
    fn parse_ordinal_number_pattern_case_1() {
        assert_eq!(parse_ordinal_number_pattern("0"), Some(0));
    }
    #[test]
    fn parse_ordinal_number_pattern_case_2() {
        assert_eq!(parse_ordinal_number_pattern("вт"), None);
    }
    #[test]
    fn parse_ordinal_number_pattern_case_3() {
        assert_eq!(parse_ordinal_number_pattern("1"), Some(1));
    }
    #[test]
    fn parse_ordinal_number_pattern_case_4() {
        assert_eq!(parse_ordinal_number_pattern("2"), Some(2));
    }
    #[test]
    fn parse_ordinal_number_pattern_case_5() {
        assert_eq!(parse_ordinal_number_pattern("15хв"), Some(15));
    }
    #[test]
    fn parse_ordinal_number_pattern_case_6() {
        assert_eq!(parse_ordinal_number_pattern("24го"), Some(24));
    }
    #[test]
    fn parse_ordinal_number_pattern_case_7() {
        assert_eq!(parse_ordinal_number_pattern("2 дні"), Some(2));
    }
    #[test]
    fn parse_ordinal_number_pattern_case_8() {
        assert_eq!(parse_ordinal_number_pattern("п'яте"), Some(5));
    }

    #[test]
    fn year_pattern_matches_upstream() {
        assert_eq!(
            YEAR_PATTERN,
            r"(?:[1-9][0-9]{0,3}(?:\s+(?:року|рік|р|р.))?\s*(?:н.е.|до н.е.|н. е.|до н. е.)|[1-2][0-9]{3}(?:\s+(?:року|рік|р|р.))?|[5-9][0-9](?:\s+(?:року|рік|р|р.))?)"
        );
    }

    #[test]
    fn parse_year_pattern_case_1() {
        assert_eq!(parse_year_pattern("0"), Some(2000));
    }
    #[test]
    fn parse_year_pattern_case_2() {
        assert_eq!(parse_year_pattern("вт"), None);
    }
    #[test]
    fn parse_year_pattern_case_3() {
        assert_eq!(parse_year_pattern("1"), Some(2001));
    }
    #[test]
    fn parse_year_pattern_case_4() {
        assert_eq!(parse_year_pattern("2"), Some(2002));
    }
    #[test]
    fn parse_year_pattern_case_5() {
        assert_eq!(parse_year_pattern("15хв"), Some(2015));
    }
    #[test]
    fn parse_year_pattern_case_6() {
        assert_eq!(parse_year_pattern("24го"), Some(2024));
    }
    #[test]
    fn parse_year_pattern_case_7() {
        assert_eq!(parse_year_pattern("2 дні"), Some(2002));
    }

    #[test]
    fn time_units_pattern_matches_upstream() {
        let single = format!(
            r"(?:{})\s{{0,3}}(?:{})",
            *NUMBER_PATTERN,
            match_any_pattern(dict_keys(TIME_UNIT_DICTIONARY))
        );
        let expect = format!(r"(?:(?:близько|приблизно)\s{{0,3}})?{single}(?:\s{{0,5}},?\s{{0,5}}{single}){{0,10}}");
        assert_eq!(*TIME_UNITS_PATTERN, expect);
    }

    #[test]
    fn parse_duration_case_1() {
        assert!(parse_duration("0").is_empty());
    }
    #[test]
    fn parse_duration_case_2() {
        dur("хв", &[(DurationUnit::Minute, 1.0)]);
    }
    #[test]
    fn parse_duration_case_3() {
        dur("год", &[(DurationUnit::Hour, 1.0)]);
    }
    #[test]
    fn parse_duration_case_4() {
        dur("дня", &[(DurationUnit::Day, 1.0)]);
    }
    #[test]
    fn parse_duration_case_5() {
        dur("15хв", &[(DurationUnit::Minute, 15.0)]);
    }
    #[test]
    fn parse_duration_case_6() {
        dur("2 дні", &[(DurationUnit::Day, 2.0)]);
    }
    #[test]
    fn parse_duration_case_7() {
        dur("3 роки", &[(DurationUnit::Year, 3.0)]);
    }
}
