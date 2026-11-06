//! upstream `locales/ru/constants.ts`. Ported in full so parser tasks don't edit this file.
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
    ("воскресенье", 0),
    ("воскресенья", 0),
    ("вск", 0),
    ("вск.", 0),
    ("понедельник", 1),
    ("понедельника", 1),
    ("пн", 1),
    ("пн.", 1),
    ("вторник", 2),
    ("вторника", 2),
    ("вт", 2),
    ("вт.", 2),
    ("среда", 3),
    ("среды", 3),
    ("среду", 3),
    ("ср", 3),
    ("ср.", 3),
    ("четверг", 4),
    ("четверга", 4),
    ("чт", 4),
    ("чт.", 4),
    ("пятница", 5),
    ("пятницу", 5),
    ("пятницы", 5),
    ("пт", 5),
    ("пт.", 5),
    ("суббота", 6),
    ("субботу", 6),
    ("субботы", 6),
    ("сб", 6),
    ("сб.", 6),
];

pub static FULL_MONTH_NAME_DICTIONARY: &Dictionary<i64> = &[
    ("январь", 1),
    ("января", 1),
    ("январе", 1),
    ("февраль", 2),
    ("февраля", 2),
    ("феврале", 2),
    ("март", 3),
    ("марта", 3),
    ("марте", 3),
    ("апрель", 4),
    ("апреля", 4),
    ("апреле", 4),
    ("май", 5),
    ("мая", 5),
    ("мае", 5),
    ("июнь", 6),
    ("июня", 6),
    ("июне", 6),
    ("июль", 7),
    ("июля", 7),
    ("июле", 7),
    ("август", 8),
    ("августа", 8),
    ("августе", 8),
    ("сентябрь", 9),
    ("сентября", 9),
    ("сентябре", 9),
    ("октябрь", 10),
    ("октября", 10),
    ("октябре", 10),
    ("ноябрь", 11),
    ("ноября", 11),
    ("ноябре", 11),
    ("декабрь", 12),
    ("декабря", 12),
    ("декабре", 12),
];

/// `{ ...FULL_MONTH_NAME_DICTIONARY, ... }`: the spread keys come first.
pub static MONTH_DICTIONARY: &Dictionary<i64> = &[
    ("январь", 1),
    ("января", 1),
    ("январе", 1),
    ("февраль", 2),
    ("февраля", 2),
    ("феврале", 2),
    ("март", 3),
    ("марта", 3),
    ("марте", 3),
    ("апрель", 4),
    ("апреля", 4),
    ("апреле", 4),
    ("май", 5),
    ("мая", 5),
    ("мае", 5),
    ("июнь", 6),
    ("июня", 6),
    ("июне", 6),
    ("июль", 7),
    ("июля", 7),
    ("июле", 7),
    ("август", 8),
    ("августа", 8),
    ("августе", 8),
    ("сентябрь", 9),
    ("сентября", 9),
    ("сентябре", 9),
    ("октябрь", 10),
    ("октября", 10),
    ("октябре", 10),
    ("ноябрь", 11),
    ("ноября", 11),
    ("ноябре", 11),
    ("декабрь", 12),
    ("декабря", 12),
    ("декабре", 12),
    ("янв", 1),
    ("янв.", 1),
    ("фев", 2),
    ("фев.", 2),
    ("мар", 3),
    ("мар.", 3),
    ("апр", 4),
    ("апр.", 4),
    ("авг", 8),
    ("авг.", 8),
    ("сен", 9),
    ("сен.", 9),
    ("окт", 10),
    ("окт.", 10),
    ("ноя", 11),
    ("ноя.", 11),
    ("дек", 12),
    ("дек.", 12),
];

pub static INTEGER_WORD_DICTIONARY: &Dictionary<i64> = &[
    ("один", 1),
    ("одна", 1),
    ("одной", 1),
    ("одну", 1),
    ("две", 2),
    ("два", 2),
    ("двух", 2),
    ("три", 3),
    ("трех", 3),
    ("трёх", 3),
    ("четыре", 4),
    ("четырех", 4),
    ("четырёх", 4),
    ("пять", 5),
    ("пяти", 5),
    ("шесть", 6),
    ("шести", 6),
    ("семь", 7),
    ("семи", 7),
    ("восемь", 8),
    ("восьми", 8),
    ("девять", 9),
    ("девяти", 9),
    ("десять", 10),
    ("десяти", 10),
    ("одиннадцать", 11),
    ("одиннадцати", 11),
    ("двенадцать", 12),
    ("двенадцати", 12),
];

pub static ORDINAL_WORD_DICTIONARY: &Dictionary<i64> = &[
    ("первое", 1),
    ("первого", 1),
    ("второе", 2),
    ("второго", 2),
    ("третье", 3),
    ("третьего", 3),
    ("четвертое", 4),
    ("четвертого", 4),
    ("пятое", 5),
    ("пятого", 5),
    ("шестое", 6),
    ("шестого", 6),
    ("седьмое", 7),
    ("седьмого", 7),
    ("восьмое", 8),
    ("восьмого", 8),
    ("девятое", 9),
    ("девятого", 9),
    ("десятое", 10),
    ("десятого", 10),
    ("одиннадцатое", 11),
    ("одиннадцатого", 11),
    ("двенадцатое", 12),
    ("двенадцатого", 12),
    ("тринадцатое", 13),
    ("тринадцатого", 13),
    ("четырнадцатое", 14),
    ("четырнадцатого", 14),
    ("пятнадцатое", 15),
    ("пятнадцатого", 15),
    ("шестнадцатое", 16),
    ("шестнадцатого", 16),
    ("семнадцатое", 17),
    ("семнадцатого", 17),
    ("восемнадцатое", 18),
    ("восемнадцатого", 18),
    ("девятнадцатое", 19),
    ("девятнадцатого", 19),
    ("двадцатое", 20),
    ("двадцатого", 20),
    ("двадцать первое", 21),
    ("двадцать первого", 21),
    ("двадцать второе", 22),
    ("двадцать второго", 22),
    ("двадцать третье", 23),
    ("двадцать третьего", 23),
    ("двадцать четвертое", 24),
    ("двадцать четвертого", 24),
    ("двадцать пятое", 25),
    ("двадцать пятого", 25),
    ("двадцать шестое", 26),
    ("двадцать шестого", 26),
    ("двадцать седьмое", 27),
    ("двадцать седьмого", 27),
    ("двадцать восьмое", 28),
    ("двадцать восьмого", 28),
    ("двадцать девятое", 29),
    ("двадцать девятого", 29),
    ("тридцатое", 30),
    ("тридцатого", 30),
    ("тридцать первое", 31),
    ("тридцать первого", 31),
];

pub static TIME_UNIT_DICTIONARY: &Dictionary<DurationUnit> = &[
    ("сек", DurationUnit::Second),
    ("секунда", DurationUnit::Second),
    ("секунд", DurationUnit::Second),
    ("секунды", DurationUnit::Second),
    ("секунду", DurationUnit::Second),
    ("секундочка", DurationUnit::Second),
    ("секундочки", DurationUnit::Second),
    ("секундочек", DurationUnit::Second),
    ("секундочку", DurationUnit::Second),
    ("мин", DurationUnit::Minute),
    ("минута", DurationUnit::Minute),
    ("минут", DurationUnit::Minute),
    ("минуты", DurationUnit::Minute),
    ("минуту", DurationUnit::Minute),
    ("минуток", DurationUnit::Minute),
    ("минутки", DurationUnit::Minute),
    ("минутку", DurationUnit::Minute),
    ("минуточек", DurationUnit::Minute),
    ("минуточки", DurationUnit::Minute),
    ("минуточку", DurationUnit::Minute),
    ("час", DurationUnit::Hour),
    ("часов", DurationUnit::Hour),
    ("часа", DurationUnit::Hour),
    ("часу", DurationUnit::Hour),
    ("часиков", DurationUnit::Hour),
    ("часика", DurationUnit::Hour),
    ("часике", DurationUnit::Hour),
    ("часик", DurationUnit::Hour),
    ("день", DurationUnit::Day),
    ("дня", DurationUnit::Day),
    ("дней", DurationUnit::Day),
    ("суток", DurationUnit::Day),
    ("сутки", DurationUnit::Day),
    ("неделя", DurationUnit::Week),
    ("неделе", DurationUnit::Week),
    ("недели", DurationUnit::Week),
    ("неделю", DurationUnit::Week),
    ("недель", DurationUnit::Week),
    ("недельке", DurationUnit::Week),
    ("недельки", DurationUnit::Week),
    ("неделек", DurationUnit::Week),
    ("месяц", DurationUnit::Month),
    ("месяце", DurationUnit::Month),
    ("месяцев", DurationUnit::Month),
    ("месяца", DurationUnit::Month),
    ("квартал", DurationUnit::Quarter),
    ("квартале", DurationUnit::Quarter),
    ("кварталов", DurationUnit::Quarter),
    ("год", DurationUnit::Year),
    ("года", DurationUnit::Year),
    ("году", DurationUnit::Year),
    ("годов", DurationUnit::Year),
    ("лет", DurationUnit::Year),
    ("годик", DurationUnit::Year),
    ("годика", DurationUnit::Year),
    ("годиков", DurationUnit::Year),
];

//-----------------------------

pub static NUMBER_PATTERN: LazyLock<String> = LazyLock::new(|| {
    format!(
        r"(?:{}|[0-9]+|[0-9]+\.[0-9]+|пол|несколько|пар(?:ы|у)|\s{{0,3}})",
        match_any_pattern(dict_keys(INTEGER_WORD_DICTIONARY))
    )
});

/// `parseNumberPattern(match)`. May be fractional (`пол` = 0.5) or `NaN`.
pub fn parse_number_pattern(m: &str) -> f64 {
    let num = m.to_lowercase();
    if let Some(v) = dict_get(INTEGER_WORD_DICTIONARY, &num) {
        return v as f64;
    }
    if num.contains("несколько") {
        return 3.0;
    } else if num.contains("пол") {
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
        r"(?:{}|[0-9]{{1,2}}(?:го|ого|е|ое)?)",
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

// Upstream's `year` helper: `(?:\s+(?:году|года|год|г|г.))?`.
macro_rules! year_suffix {
    () => {
        r"(?:\s+(?:году|года|год|г|г.))?"
    };
}

pub const YEAR_PATTERN: &str = concat!(
    r"(?:[1-9][0-9]{0,3}",
    year_suffix!(),
    r"\s*(?:н.э.|до н.э.|н. э.|до н. э.)|[1-2][0-9]{3}",
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

/// `parseYear(match)`. `None` is `NaN`.
pub fn parse_year(m: &str) -> Option<i64> {
    let mut m = m.to_string();
    let era_word = js_regex!(r"(год|года|г|г.)", "i");
    if era_word.is_match(&m) {
        m = replace_first(&m, era_word.exec(&m));
    }

    let bce = js_regex!(r"(до н.э.|до н. э.)", "i");
    if bce.is_match(&m) {
        // Before Common Era
        return js_parse_int(&replace_first(&m, bce.exec(&m))).map(|y| -y);
    }

    let ce = js_regex!(r"(н. э.|н.э.)", "i");
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
    LazyLock::new(|| repeated_timeunit_pattern(r"(?:(?:около|примерно)\s{0,3})?", &SINGLE_TIME_UNIT_PATTERN, None));

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
    use DurationUnit::*;

    fn dict_eq<V: Copy + PartialEq + std::fmt::Debug>(d: &Dictionary<V>, n: usize, last: (&str, V)) {
        assert_eq!(d.len(), n);
        assert_eq!(d[n - 1], last);
        let mut keys: Vec<&str> = dict_keys(d).collect();
        keys.sort_unstable();
        keys.dedup();
        assert_eq!(keys.len(), n);
    }

    #[test]
    fn regex_parts_matches_upstream() {
        assert_eq!(LEFT_BOUNDARY, r"([^\p{L}\p{N}_]|^)");
        assert_eq!(RIGHT_BOUNDARY, r"(?=[^\p{L}\p{N}_]|$)");
        assert_eq!(FLAGS, "iu");
    }

    #[test]
    fn weekday_dictionary_matches_upstream() {
        dict_eq(WEEKDAY_DICTIONARY, 31, ("сб.", 6));
        assert_eq!(dict_get(WEEKDAY_DICTIONARY, "среду"), Some(3));
    }

    #[test]
    fn full_month_name_dictionary_matches_upstream() {
        dict_eq(FULL_MONTH_NAME_DICTIONARY, 36, ("декабре", 12));
    }

    #[test]
    fn month_dictionary_matches_upstream() {
        dict_eq(MONTH_DICTIONARY, 54, ("дек.", 12));
        assert_eq!(dict_get(MONTH_DICTIONARY, "май"), Some(5));
    }

    #[test]
    fn integer_word_dictionary_matches_upstream() {
        dict_eq(INTEGER_WORD_DICTIONARY, 29, ("двенадцати", 12));
    }

    #[test]
    fn ordinal_word_dictionary_matches_upstream() {
        dict_eq(ORDINAL_WORD_DICTIONARY, 62, ("тридцать первого", 31));
    }

    #[test]
    fn time_unit_dictionary_matches_upstream() {
        dict_eq(TIME_UNIT_DICTIONARY, 56, ("годиков", Year));
        assert_eq!(dict_get(TIME_UNIT_DICTIONARY, "суток"), Some(Day));
    }

    #[test]
    fn number_pattern_matches_upstream() {
        let expect = r"(?:(?:одиннадцать|одиннадцати|двенадцать|двенадцати|четырех|четырёх|четыре|восемь|восьми|девять|девяти|десять|десяти|одной|шесть|шести|один|одна|одну|двух|трех|трёх|пять|пяти|семь|семи|две|два|три)|[0-9]+|[0-9]+\.[0-9]+|пол|несколько|пар(?:ы|у)|\s{0,3})";
        assert_eq!(*NUMBER_PATTERN, expect);
    }

    fn num(s: &str, v: Option<f64>) {
        let got = parse_number_pattern(s);
        match v {
            Some(v) => assert_eq!(got, v, "{s}"),
            None => assert!(got.is_nan(), "{s}"),
        }
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
        num("три", Some(3.0));
    }
    #[test]
    fn parse_number_pattern_case_7() {
        num("24го", Some(24.0));
    }
    #[test]
    fn parse_number_pattern_case_8() {
        num("94 г", Some(94.0));
    }

    #[test]
    fn ordinal_number_pattern_matches_upstream() {
        let expect = r"(?:(?:двадцать четвертого|двадцать четвертое|двадцать третьего|двадцать седьмого|двадцать восьмого|двадцать девятого|двадцать первого|двадцать второго|двадцать шестого|двадцать седьмое|двадцать восьмое|двадцать девятое|тридцать первого|двадцать первое|двадцать второе|двадцать третье|двадцать пятого|двадцать шестое|тридцать первое|четырнадцатого|восемнадцатого|девятнадцатого|двадцать пятое|одиннадцатого|четырнадцатое|шестнадцатого|восемнадцатое|девятнадцатое|одиннадцатое|двенадцатого|тринадцатого|пятнадцатого|шестнадцатое|семнадцатого|двенадцатое|тринадцатое|пятнадцатое|семнадцатое|четвертого|двадцатого|тридцатого|четвертое|двадцатое|тридцатое|третьего|седьмого|восьмого|девятого|десятого|первого|второго|шестого|седьмое|восьмое|девятое|десятое|первое|второе|третье|пятого|шестое|пятое)|[0-9]{1,2}(?:го|ого|е|ое)?)";
        assert_eq!(*ORDINAL_NUMBER_PATTERN, expect);
        JsRegex::new(&ORDINAL_NUMBER_PATTERN, "i");
    }

    fn ord(s: &str, v: Option<i64>) {
        assert_eq!(parse_ordinal_number_pattern(s), v, "{s}");
    }

    #[test]
    fn parse_ordinal_number_pattern_case_1() {
        ord("0", Some(0));
    }
    #[test]
    fn parse_ordinal_number_pattern_case_2() {
        ord("вт", None);
    }
    #[test]
    fn parse_ordinal_number_pattern_case_3() {
        ord("1", Some(1));
    }
    #[test]
    fn parse_ordinal_number_pattern_case_4() {
        ord("2", Some(2));
    }
    #[test]
    fn parse_ordinal_number_pattern_case_5() {
        ord("24го", Some(24));
    }
    #[test]
    fn parse_ordinal_number_pattern_case_6() {
        ord("94 г", Some(94));
    }
    #[test]
    fn parse_ordinal_number_pattern_case_7() {
        ord("15мин", Some(15));
    }
    #[test]
    fn parse_ordinal_number_pattern_case_8() {
        ord("третье", Some(3));
    }

    #[test]
    fn year_pattern_matches_upstream() {
        let y = r"(?:\s+(?:году|года|год|г|г.))?";
        assert_eq!(
            YEAR_PATTERN,
            format!(r"(?:[1-9][0-9]{{0,3}}{y}\s*(?:н.э.|до н.э.|н. э.|до н. э.)|[1-2][0-9]{{3}}{y}|[5-9][0-9]{y})")
        );
    }

    fn year(s: &str, v: Option<i64>) {
        assert_eq!(parse_year(s), v, "{s}");
    }

    #[test]
    fn parse_year_case_1() {
        year("0", Some(2000));
    }
    #[test]
    fn parse_year_case_2() {
        year("вт", None);
    }
    #[test]
    fn parse_year_case_3() {
        year("1", Some(2001));
    }
    #[test]
    fn parse_year_case_4() {
        year("2", Some(2002));
    }
    #[test]
    fn parse_year_case_5() {
        year("24го", Some(2024));
    }
    #[test]
    fn parse_year_case_6() {
        year("94 г", Some(1994));
    }
    #[test]
    fn parse_year_case_7() {
        year("15мин", Some(2015));
    }

    #[test]
    fn time_units_pattern_matches_upstream() {
        let number = r"(?:(?:одиннадцать|одиннадцати|двенадцать|двенадцати|четырех|четырёх|четыре|восемь|восьми|девять|девяти|десять|десяти|одной|шесть|шести|один|одна|одну|двух|трех|трёх|пять|пяти|семь|семи|две|два|три)|[0-9]+|[0-9]+\.[0-9]+|пол|несколько|пар(?:ы|у)|\s{0,3})";
        let units = r"(?:(?:секундочка|секундочки|секундочек|секундочку|минуточек|минуточки|минуточку|кварталов|недельке|недельки|квартале|секунда|секунды|секунду|минуток|минутки|минутку|часиков|неделек|месяцев|квартал|годиков|секунд|минута|минуты|минуту|часика|часике|неделя|неделе|недели|неделю|недель|месяце|месяца|годика|минут|часов|часик|суток|сутки|месяц|годов|годик|часа|часу|день|дней|года|году|сек|мин|час|дня|год|лет))";
        let single = format!(r"(?:{number}){}\s{{0,3}}{units}", "");
        assert_eq!(
            *TIME_UNITS_PATTERN,
            format!(r"(?:(?:около|примерно)\s{{0,3}})?{single}(?:\s{{0,5}},?\s{{0,5}}{single}){{0,10}}")
        );
    }

    fn dur(s: &str, pairs: &[(DurationUnit, f64)]) {
        assert_eq!(parse_duration(s), Duration::from_pairs(pairs), "{s}");
    }

    #[test]
    fn parse_duration_case_1() {
        dur("0", &[]);
    }
    #[test]
    fn parse_duration_case_2() {
        dur("год", &[(Year, 1.0)]);
    }
    #[test]
    fn parse_duration_case_3() {
        dur("дня", &[(Day, 1.0)]);
    }
    #[test]
    fn parse_duration_case_4() {
        dur("мин", &[(Minute, 1.0)]);
    }
    #[test]
    fn parse_duration_case_5() {
        dur("15мин", &[(Minute, 15.0)]);
    }
    #[test]
    fn parse_duration_case_6() {
        dur("2 дня", &[(Day, 2.0)]);
    }
    #[test]
    fn parse_duration_case_7() {
        dur("2 часа", &[(Hour, 2.0)]);
    }
}
