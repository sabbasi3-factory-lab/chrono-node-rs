//! upstream `locales/ar/constants.ts`. Ported in full so parser tasks don't edit this file.
//!
//! Dictionaries are `(key, value)` slices **in upstream's key order**. It matters:
//! `match_any_pattern` sorts stably, so equal-length keys keep this order.

use std::sync::LazyLock;

use crate::calculation::duration::{Duration, DurationUnit};
use crate::calculation::years::find_most_likely_ad_year;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::js::{js_parse_float, js_parse_int, js_trim};
use crate::core::utils::pattern::{dict_get, dict_keys, match_any_pattern, repeated_timeunit_pattern, Dictionary};
use crate::js_regex;

/// Upstream's `REGEX_PARTS` object.
pub struct RegexParts {
    pub left_boundary: &'static str,
    pub right_boundary: &'static str,
    pub flags: &'static str,
}

pub static REGEX_PARTS: RegexParts = RegexParts {
    left_boundary: r"([^\p{L}\p{N}_]|^)",
    right_boundary: r"(?=[^\p{L}\p{N}_]|$)",
    flags: "iu",
};

/// `toWesternDigits(text)`: Arabic-Indic digits U+0660..U+0669 become ASCII digits.
pub fn to_western_digits(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            '\u{660}'..='\u{669}' => char::from(b'0' + (c as u32 - 0x660) as u8),
            _ => c,
        })
        .collect()
}

pub static WEEKDAY_DICTIONARY: &Dictionary<i64> = &[
    ("الأحد", 0),
    ("الاحد", 0),
    ("أحد", 0),
    ("احد", 0),
    ("الإثنين", 1),
    ("الاثنين", 1),
    ("إثنين", 1),
    ("اثنين", 1),
    ("الثلاثاء", 2),
    ("ثلاثاء", 2),
    ("الأربعاء", 3),
    ("الاربعاء", 3),
    ("أربعاء", 3),
    ("اربعاء", 3),
    ("الخميس", 4),
    ("خميس", 4),
    ("الجمعة", 5),
    ("جمعة", 5),
    ("السبت", 6),
    ("سبت", 6),
];

pub static FULL_MONTH_NAME_DICTIONARY: &Dictionary<i64> = &[
    // Standard Gregorian
    ("يناير", 1),
    ("فبراير", 2),
    ("مارس", 3),
    ("أبريل", 4),
    ("ابريل", 4),
    ("مايو", 5),
    ("يونيو", 6),
    ("يوليو", 7),
    ("أغسطس", 8),
    ("اغسطس", 8),
    ("سبتمبر", 9),
    ("أكتوبر", 10),
    ("اكتوبر", 10),
    ("نوفمبر", 11),
    ("ديسمبر", 12),
    // Levantine / Mesopotamian Gregorian
    ("كانون الثاني", 1),
    ("شباط", 2),
    ("آذار", 3),
    ("اذار", 3),
    ("نيسان", 4),
    ("أيار", 5),
    ("ايار", 5),
    ("حزيران", 6),
    ("تموز", 7),
    ("آب", 8),
    ("اب", 8),
    ("أيلول", 9),
    ("ايلول", 9),
    ("تشرين الأول", 10),
    ("تشرين الاول", 10),
    ("تشرين الثاني", 11),
    ("كانون الأول", 12),
    ("كانون الاول", 12),
];

pub static MONTH_DICTIONARY: &Dictionary<i64> = FULL_MONTH_NAME_DICTIONARY;

pub static INTEGER_WORD_DICTIONARY: &Dictionary<f64> = &[
    ("واحد", 1.0),
    ("واحدة", 1.0),
    ("اثنان", 2.0),
    ("اثنين", 2.0),
    ("اثنتان", 2.0),
    ("اثنتين", 2.0),
    ("ثلاثة", 3.0),
    ("ثلاث", 3.0),
    ("أربعة", 4.0),
    ("اربعة", 4.0),
    ("أربع", 4.0),
    ("اربع", 4.0),
    ("خمسة", 5.0),
    ("خمس", 5.0),
    ("ستة", 6.0),
    ("ست", 6.0),
    ("سبعة", 7.0),
    ("سبع", 7.0),
    ("ثمانية", 8.0),
    ("ثماني", 8.0),
    ("ثمان", 8.0),
    ("تسعة", 9.0),
    ("تسع", 9.0),
    ("عشرة", 10.0),
    ("عشر", 10.0),
    ("أحد عشر", 11.0),
    ("احد عشر", 11.0),
    ("إحدى عشرة", 11.0),
    ("احدى عشرة", 11.0),
    ("اثنا عشر", 12.0),
    ("اثني عشر", 12.0),
    ("اثنتا عشرة", 12.0),
    ("اثنتي عشرة", 12.0),
    ("نصف", 0.5),
    ("نص", 0.5),
    ("ربع", 0.25),
];

pub static ORDINAL_WORD_DICTIONARY: &Dictionary<i64> = &[
    ("الأول", 1),
    ("الاول", 1),
    ("الأولى", 1),
    ("الاولى", 1),
    ("أول", 1),
    ("اول", 1),
    ("حادي", 1),
    ("الحادي", 1),
    ("الثاني", 2),
    ("الثانية", 2),
    ("ثاني", 2),
    ("الثالث", 3),
    ("الثالثة", 3),
    ("ثالث", 3),
    ("الرابع", 4),
    ("الرابعة", 4),
    ("رابع", 4),
    ("الخامس", 5),
    ("الخامسة", 5),
    ("خامس", 5),
    ("السادس", 6),
    ("السادسة", 6),
    ("سادس", 6),
    ("السابع", 7),
    ("السابعة", 7),
    ("سابع", 7),
    ("الثامن", 8),
    ("الثامنة", 8),
    ("ثامن", 8),
    ("التاسع", 9),
    ("التاسعة", 9),
    ("تاسع", 9),
    ("العاشر", 10),
    ("العاشرة", 10),
    ("عاشر", 10),
    ("الحادي عشر", 11),
    ("الحادية عشرة", 11),
    ("الثاني عشر", 12),
    ("الثانية عشرة", 12),
    ("الثالث عشر", 13),
    ("الثالثة عشرة", 13),
    ("الرابع عشر", 14),
    ("الرابعة عشرة", 14),
    ("الخامس عشر", 15),
    ("الخامسة عشرة", 15),
    ("السادس عشر", 16),
    ("السادسة عشرة", 16),
    ("السابع عشر", 17),
    ("السابعة عشرة", 17),
    ("الثامن عشر", 18),
    ("الثامنة عشرة", 18),
    ("التاسع عشر", 19),
    ("التاسعة عشرة", 19),
    ("العشرون", 20),
    ("العشرين", 20),
    ("الحادي والعشرون", 21),
    ("الحادية والعشرون", 21),
    ("الواحد والعشرون", 21),
    ("الثاني والعشرون", 22),
    ("الثانية والعشرون", 22),
    ("الثالث والعشرون", 23),
    ("الثالثة والعشرون", 23),
    ("الرابع والعشرون", 24),
    ("الرابعة والعشرون", 24),
    ("الخامس والعشرون", 25),
    ("الخامسة والعشرون", 25),
    ("السادس والعشرون", 26),
    ("السادسة والعشرون", 26),
    ("السابع والعشرون", 27),
    ("السابعة والعشرون", 27),
    ("الثامن والعشرون", 28),
    ("الثامنة والعشرون", 28),
    ("التاسع والعشرون", 29),
    ("التاسعة والعشرون", 29),
    ("الثلاثون", 30),
    ("الثلاثين", 30),
    ("الحادي والثلاثون", 31),
    ("الحادية والثلاثون", 31),
    ("الواحد والثلاثون", 31),
];

pub static TIME_UNIT_DICTIONARY: &Dictionary<DurationUnit> = &[
    // Second
    ("ثانية", DurationUnit::Second),
    ("ثانيةً", DurationUnit::Second),
    ("ثواني", DurationUnit::Second),
    ("ثوان", DurationUnit::Second),
    ("ثوانٍ", DurationUnit::Second),
    // Minute
    ("دقيقة", DurationUnit::Minute),
    ("دقيقةً", DurationUnit::Minute),
    ("دقائق", DurationUnit::Minute),
    // Hour
    ("ساعة", DurationUnit::Hour),
    ("ساعةً", DurationUnit::Hour),
    ("ساعات", DurationUnit::Hour),
    // Day
    ("يوم", DurationUnit::Day),
    ("يوماً", DurationUnit::Day),
    ("يوما", DurationUnit::Day),
    ("أيام", DurationUnit::Day),
    ("ايام", DurationUnit::Day),
    // Week
    ("أسبوع", DurationUnit::Week),
    ("اسبوع", DurationUnit::Week),
    ("أسبوعاً", DurationUnit::Week),
    ("أسبوعا", DurationUnit::Week),
    ("اسبوعاً", DurationUnit::Week),
    ("اسبوعا", DurationUnit::Week),
    ("أسابيع", DurationUnit::Week),
    ("اسابيع", DurationUnit::Week),
    // Month
    ("شهر", DurationUnit::Month),
    ("شهراً", DurationUnit::Month),
    ("شهرا", DurationUnit::Month),
    ("أشهر", DurationUnit::Month),
    ("اشهر", DurationUnit::Month),
    ("شهور", DurationUnit::Month),
    // Year
    ("سنة", DurationUnit::Year),
    ("سنةً", DurationUnit::Year),
    ("سنوات", DurationUnit::Year),
    ("سنين", DurationUnit::Year),
    ("عام", DurationUnit::Year),
    ("عاماً", DurationUnit::Year),
    ("عاما", DurationUnit::Year),
    ("أعوام", DurationUnit::Year),
    ("اعوام", DurationUnit::Year),
];

pub static DUAL_TIME_UNIT_DICTIONARY: &Dictionary<DurationUnit> = &[
    ("ثانيتان", DurationUnit::Second),
    ("ثانيتين", DurationUnit::Second),
    ("دقيقتان", DurationUnit::Minute),
    ("دقيقتين", DurationUnit::Minute),
    ("ساعتان", DurationUnit::Hour),
    ("ساعتين", DurationUnit::Hour),
    ("يومان", DurationUnit::Day),
    ("يومين", DurationUnit::Day),
    ("أسبوعان", DurationUnit::Week),
    ("اسبوعان", DurationUnit::Week),
    ("أسبوعين", DurationUnit::Week),
    ("اسبوعين", DurationUnit::Week),
    ("شهران", DurationUnit::Month),
    ("شهرين", DurationUnit::Month),
    ("سنتان", DurationUnit::Year),
    ("سنتين", DurationUnit::Year),
    ("عامان", DurationUnit::Year),
    ("عامين", DurationUnit::Year),
];

pub static NUMBER_PATTERN: LazyLock<String> = LazyLock::new(|| {
    format!(
        r"(?:{}|[0-9٠-٩]+|[0-9٠-٩]+[\.,][0-9٠-٩]+|\s{{0,3}})",
        match_any_pattern(dict_keys(INTEGER_WORD_DICTIONARY))
    )
});

/// `parseNumberPattern(match)`. `None` is `NaN`.
pub fn parse_number_pattern(m: &str) -> Option<f64> {
    let clean = js_trim(m);
    if let Some(v) = dict_get(INTEGER_WORD_DICTIONARY, clean) {
        return Some(v);
    }
    if clean.is_empty() {
        return Some(1.0);
    }
    let western = to_western_digits(clean).replacen(',', ".", 1);
    let n = js_parse_float(&western);
    (!n.is_nan()).then_some(n)
}

pub static ORDINAL_NUMBER_PATTERN: LazyLock<String> = LazyLock::new(|| {
    format!(
        "(?:{}|[0-9٠-٩]{{1,2}})",
        match_any_pattern(dict_keys(ORDINAL_WORD_DICTIONARY))
    )
});

/// `parseOrdinalNumberPattern(match)`. `None` is `NaN`.
pub fn parse_ordinal_number_pattern(m: &str) -> Option<i64> {
    let clean = js_trim(m);
    if let Some(v) = dict_get(ORDINAL_WORD_DICTIONARY, clean) {
        return Some(v);
    }
    js_parse_int(&to_western_digits(clean))
}

const YEAR_SUFFIX: &str = r"(?:\s*(?:ميلادية|ميلادي|م))?";
const BC_SUFFIX: &str = r"(?:\s*(?:قبل الميلاد|ق\.م))";

pub static YEAR_PATTERN: LazyLock<String> = LazyLock::new(|| {
    format!(
        "(?:[1-9١-٩][0-9٠-٩]{{0,3}}{YEAR_SUFFIX}{BC_SUFFIX}|[1-2١-٢][0-9٠-٩]{{3}}{YEAR_SUFFIX}|[5-9٥-٩][0-9٠-٩]{YEAR_SUFFIX})"
    )
});

/// `parseYear(match)`. `None` is `NaN`.
pub fn parse_year(m: &str) -> Option<i64> {
    let clean = js_trim(m);
    let is_bc = js_regex!(r"(قبل الميلاد|ق\.م)", "i").is_match(clean);
    // `clean.replace(/(قبل الميلاد|ق\.م|ميلادية|ميلادي|م)/gi, "")`
    let re = js_regex!(r"(قبل الميلاد|ق\.م|ميلادية|ميلادي|م)", "i");
    let mut stripped = String::new();
    let mut rest = clean;
    while let Some(found) = re.exec(rest) {
        stripped.push_str(&rest[..found.index]);
        rest = &rest[found.index + found.text().len()..];
    }
    stripped.push_str(rest);
    let western = to_western_digits(js_trim(&stripped));
    let raw_year_number = js_parse_int(&western)?;
    if is_bc {
        return Some(-raw_year_number);
    }
    Some(find_most_likely_ad_year(raw_year_number))
}

pub static TIME_UNIT_CONNECTOR_PATTERN: &str = r"\s{0,5},?(?:\s*و)?\s{0,5}";

static DUAL_UNIT_PATTERN: LazyLock<String> =
    LazyLock::new(|| format!("({})", match_any_pattern(dict_keys(DUAL_TIME_UNIT_DICTIONARY))));

static NUMBER_WITH_UNIT_PATTERN: LazyLock<String> = LazyLock::new(|| {
    format!(
        r"(?:({})\s{{0,3}})?({})",
        *NUMBER_PATTERN,
        match_any_pattern(dict_keys(TIME_UNIT_DICTIONARY))
    )
});

const HALF_UNIT_PATTERN: &str = r"(?:و\s*)?(نصف|نص|ربع)";

static SINGLE_TIME_UNIT_PATTERN: LazyLock<String> =
    LazyLock::new(|| format!("(?:{}|{}|{})", *DUAL_UNIT_PATTERN, *NUMBER_WITH_UNIT_PATTERN, HALF_UNIT_PATTERN));

static SINGLE_TIME_UNIT_REGEX: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new(&SINGLE_TIME_UNIT_PATTERN, REGEX_PARTS.flags));

pub static TIME_UNITS_PATTERN: LazyLock<String> = LazyLock::new(|| {
    repeated_timeunit_pattern(
        "(?:(?:خلال|في غضون|في خلال|حوالي|تقريباً|تقريبا)\\s{0,3})?",
        &SINGLE_TIME_UNIT_PATTERN,
        Some(TIME_UNIT_CONNECTOR_PATTERN),
    )
});

/// `parseDuration(timeunitText)`. An input with no time unit gives an empty duration (`{}`).
pub fn parse_duration(timeunit_text: &str) -> Duration {
    let mut fragments = Duration::new();
    let mut remaining = timeunit_text.to_string();
    let mut last_unit: Option<DurationUnit> = None;
    let mut found = SINGLE_TIME_UNIT_REGEX.exec(&remaining);
    while let Some(m) = found {
        last_unit = collect_date_time_fragment(&mut fragments, &m, last_unit);
        remaining = js_trim(&remaining[m.index + m.text().len()..]).to_string();
        if remaining.is_empty() {
            break;
        }
        found = SINGLE_TIME_UNIT_REGEX.exec(&remaining);
    }
    fragments
}

/// `(fragments[unit] || 0) + value`; a `NaN` or `0` previous value counts as `0`.
fn add_fragment(fragments: &mut Duration, unit: DurationUnit, value: f64) {
    let previous = fragments.get(unit).filter(|v| *v != 0.0 && !v.is_nan()).unwrap_or(0.0);
    fragments.set(unit, previous + value);
}

fn collect_date_time_fragment(
    fragments: &mut Duration,
    m: &RegexMatch,
    last_unit: Option<DurationUnit>,
) -> Option<DurationUnit> {
    let truthy = |i: usize| m.get(i).is_some_and(|s| !s.is_empty());
    if truthy(1) {
        // Dual form (e.g. يومين, ساعتين)
        let dual_word = js_trim(m.get(1).unwrap_or(""));
        if let Some(unit) = dict_get(DUAL_TIME_UNIT_DICTIONARY, dual_word) {
            add_fragment(fragments, unit, 2.0);
            return Some(unit);
        }
    } else if truthy(3) {
        // Standard form (e.g. 3 أيام, ساعة)
        let num_str = m.get(2).map_or("", js_trim);
        let num = parse_number_pattern(num_str).unwrap_or(f64::NAN);
        let unit_word = js_trim(m.get(3).unwrap_or(""));
        if let Some(unit) = dict_get(TIME_UNIT_DICTIONARY, unit_word) {
            add_fragment(fragments, unit, num);
            return Some(unit);
        }
    } else if truthy(4) {
        // Half / Fraction form (e.g. ونصف, نصف, ربع)
        let frac_word = js_trim(m.get(4).unwrap_or(""));
        let frac = if frac_word == "ربع" { 0.25 } else { 0.5 };
        if let Some(unit) = last_unit {
            add_fragment(fragments, unit, frac);
            return Some(unit);
        }
    }
    last_unit
}

#[cfg(test)]
mod tests {
    //! Expected values come from the contract, recorded from the pinned chrono-node.
    use super::*;

    fn num(input: &str, expect: Option<f64>) {
        assert_eq!(parse_number_pattern(input), expect, "{input}");
    }

    fn ord(input: &str, expect: Option<i64>) {
        assert_eq!(parse_ordinal_number_pattern(input), expect, "{input}");
    }

    fn year(input: &str, expect: Option<i64>) {
        assert_eq!(parse_year(input), expect, "{input}");
    }

    fn dur(input: &str, expect: &[(DurationUnit, f64)]) {
        let got: Vec<_> = parse_duration(input).iter().collect();
        assert_eq!(got, expect, "{input}");
    }

    fn check_dict<V: Copy + PartialEq + std::fmt::Debug>(d: &Dictionary<V>, len: usize, samples: &[(&str, V)]) {
        assert_eq!(d.len(), len);
        for (k, v) in samples {
            assert_eq!(dict_get(d, k), Some(*v), "{k}");
        }
    }

    #[test]
    fn regex_parts_matches_upstream() {
        assert_eq!(REGEX_PARTS.left_boundary, r"([^\p{L}\p{N}_]|^)");
        assert_eq!(REGEX_PARTS.right_boundary, r"(?=[^\p{L}\p{N}_]|$)");
        assert_eq!(REGEX_PARTS.flags, "iu");
    }

    #[test]
    fn to_western_digits_case_1() {
        assert_eq!(to_western_digits(","), ",");
    }
    #[test]
    fn to_western_digits_case_2() {
        assert_eq!(to_western_digits("آب"), "آب");
    }
    #[test]
    fn to_western_digits_case_3() {
        assert_eq!(to_western_digits("1"), "1");
    }
    #[test]
    fn to_western_digits_case_4() {
        assert_eq!(to_western_digits("0"), "0");
    }
    #[test]
    fn to_western_digits_case_5() {
        assert_eq!(to_western_digits("اب"), "اب");
    }
    #[test]
    fn to_western_digits_case_6() {
        assert_eq!(to_western_digits("2"), "2");
    }
    #[test]
    fn to_western_digits_case_7() {
        assert_eq!(to_western_digits("3 أيام"), "3 أيام");
    }
    #[test]
    fn to_western_digits_case_8() {
        assert_eq!(to_western_digits("15 يوما"), "15 يوما");
        assert_eq!(to_western_digits("٠١٢٣٤٥٦٧٨٩"), "0123456789");
    }

    #[test]
    fn weekday_dictionary_matches_upstream() {
        check_dict(WEEKDAY_DICTIONARY, 20, &[("الأحد", 0), ("إثنين", 1), ("الأربعاء", 3), ("سبت", 6)]);
    }

    #[test]
    fn full_month_name_dictionary_matches_upstream() {
        check_dict(
            FULL_MONTH_NAME_DICTIONARY,
            33,
            &[("يناير", 1), ("كانون الثاني", 1), ("آب", 8), ("تشرين الأول", 10), ("كانون الاول", 12)],
        );
    }

    #[test]
    fn month_dictionary_matches_upstream() {
        assert_eq!(MONTH_DICTIONARY, FULL_MONTH_NAME_DICTIONARY);
    }

    #[test]
    fn integer_word_dictionary_matches_upstream() {
        check_dict(
            INTEGER_WORD_DICTIONARY,
            36,
            &[("واحد", 1.0), ("اثنتي عشرة", 12.0), ("نصف", 0.5), ("نص", 0.5), ("ربع", 0.25)],
        );
    }

    #[test]
    fn ordinal_word_dictionary_matches_upstream() {
        check_dict(
            ORDINAL_WORD_DICTIONARY,
            79,
            &[("الأول", 1), ("حادي", 1), ("الثالث عشر", 13), ("الواحد والعشرون", 21), ("الواحد والثلاثون", 31)],
        );
    }

    #[test]
    fn time_unit_dictionary_matches_upstream() {
        use DurationUnit::*;
        check_dict(
            TIME_UNIT_DICTIONARY,
            39,
            &[("ثوانٍ", Second), ("دقائق", Minute), ("يوما", Day), ("اسابيع", Week), ("شهور", Month), ("اعوام", Year)],
        );
    }

    #[test]
    fn dual_time_unit_dictionary_matches_upstream() {
        use DurationUnit::*;
        check_dict(DUAL_TIME_UNIT_DICTIONARY, 18, &[("ثانيتان", Second), ("اسبوعين", Week), ("عامين", Year)]);
    }

    #[test]
    fn number_pattern_matches_upstream() {
        assert_eq!(
            *NUMBER_PATTERN,
            r"(?:(?:اثنتا عشرة|اثنتي عشرة|إحدى عشرة|احدى عشرة|اثنا عشر|اثني عشر|أحد عشر|احد عشر|اثنتان|اثنتين|ثمانية|واحدة|اثنان|اثنين|ثلاثة|أربعة|اربعة|ثماني|واحد|ثلاث|أربع|اربع|خمسة|سبعة|ثمان|تسعة|عشرة|خمس|ستة|سبع|تسع|عشر|نصف|ربع|ست|نص)|[0-9٠-٩]+|[0-9٠-٩]+[\.,][0-9٠-٩]+|\s{0,3})"
        );
    }

    #[test]
    fn parse_number_pattern_case_1() {
        num(",", None);
    }
    #[test]
    fn parse_number_pattern_case_2() {
        num("1", Some(1.0));
    }
    #[test]
    fn parse_number_pattern_case_3() {
        num("0", Some(0.0));
    }
    #[test]
    fn parse_number_pattern_case_4() {
        num("2", Some(2.0));
    }
    #[test]
    fn parse_number_pattern_case_5() {
        num("ست", Some(6.0));
    }
    #[test]
    fn parse_number_pattern_case_6() {
        num("نص", Some(0.5));
    }
    #[test]
    fn parse_number_pattern_case_7() {
        num("3 أيام", Some(3.0));
    }
    #[test]
    fn parse_number_pattern_case_8() {
        num("15 يوما", Some(15.0));
        num("", Some(1.0));
        num("١٫٥", Some(1.0));
        num("٣,٥", Some(3.5));
    }

    #[test]
    fn ordinal_number_pattern_matches_upstream() {
        let p = &*ORDINAL_NUMBER_PATTERN;
        assert!(p.starts_with("(?:(?:الحادية والثلاثون|الحادية والعشرون|"));
        assert!(p.ends_with("|أول|اول)|[0-9٠-٩]{1,2})"));
    }

    #[test]
    fn parse_ordinal_number_pattern_case_1() {
        ord(",", None);
    }
    #[test]
    fn parse_ordinal_number_pattern_case_2() {
        ord("1", Some(1));
    }
    #[test]
    fn parse_ordinal_number_pattern_case_3() {
        ord("0", Some(0));
    }
    #[test]
    fn parse_ordinal_number_pattern_case_4() {
        ord("2", Some(2));
    }
    #[test]
    fn parse_ordinal_number_pattern_case_5() {
        ord("أول", Some(1));
    }
    #[test]
    fn parse_ordinal_number_pattern_case_6() {
        ord("٨", Some(8));
    }
    #[test]
    fn parse_ordinal_number_pattern_case_7() {
        ord("3 أيام", Some(3));
    }
    #[test]
    fn parse_ordinal_number_pattern_case_8() {
        ord("15 يوما", Some(15));
    }

    #[test]
    fn year_pattern_matches_upstream() {
        assert_eq!(
            *YEAR_PATTERN,
            r"(?:[1-9١-٩][0-9٠-٩]{0,3}(?:\s*(?:ميلادية|ميلادي|م))?(?:\s*(?:قبل الميلاد|ق\.م))|[1-2١-٢][0-9٠-٩]{3}(?:\s*(?:ميلادية|ميلادي|م))?|[5-9٥-٩][0-9٠-٩](?:\s*(?:ميلادية|ميلادي|م))?)"
        );
    }

    #[test]
    fn parse_year_case_1() {
        year(",", None);
    }
    #[test]
    fn parse_year_case_2() {
        year("1", Some(2001));
    }
    #[test]
    fn parse_year_case_3() {
        year("0", Some(2000));
    }
    #[test]
    fn parse_year_case_4() {
        year("2", Some(2002));
    }
    #[test]
    fn parse_year_case_5() {
        year("٨", Some(2008));
    }
    #[test]
    fn parse_year_case_6() {
        year("١٥", Some(2015));
    }
    #[test]
    fn parse_year_case_7() {
        year("3 أيام", Some(2003));
    }
    #[test]
    fn parse_year_case_8() {
        year("15 يوما", Some(2015));
        year("2024 م", Some(2024));
        year("500 قبل الميلاد", Some(-500));
    }

    #[test]
    fn time_unit_connector_pattern_matches_upstream() {
        assert_eq!(TIME_UNIT_CONNECTOR_PATTERN, r"\s{0,5},?(?:\s*و)?\s{0,5}");
    }

    #[test]
    fn time_units_pattern_matches_upstream() {
        let p = &*TIME_UNITS_PATTERN;
        assert!(p.starts_with(r"(?:(?:خلال|في غضون|في خلال|حوالي|تقريباً|تقريبا)\s{0,3})?(?:(?:(?:ثانيتان|"));
        assert!(p.ends_with(r"){0,10}"));
        assert!(!p.contains("(نصف") && !p.contains("(("));
        let re = JsRegex::new(p, "iu");
        assert_eq!(re.exec("بعد 3 أيام و ساعتين").map(|m| m.text().to_string()).as_deref(), Some("3 أيام و ساعتين"));
    }

    #[test]
    fn parse_duration_case_1() {
        dur(",", &[]);
    }
    #[test]
    fn parse_duration_case_2() {
        dur("سنة", &[(DurationUnit::Year, 1.0)]);
    }
    #[test]
    fn parse_duration_case_3() {
        dur("شهر", &[(DurationUnit::Month, 1.0)]);
    }
    #[test]
    fn parse_duration_case_4() {
        dur("3 أيام", &[(DurationUnit::Day, 3.0)]);
    }
    #[test]
    fn parse_duration_case_5() {
        dur("15 يوما", &[(DurationUnit::Day, 15.0)]);
    }
    #[test]
    fn parse_duration_case_6() {
        dur("3 ساعات", &[(DurationUnit::Hour, 3.0)]);
        dur("يومين", &[(DurationUnit::Day, 2.0)]);
        dur("ساعة ونصف", &[(DurationUnit::Hour, 1.5)]);
    }
}
