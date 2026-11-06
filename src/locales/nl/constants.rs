//! upstream `locales/nl/constants.ts`. Ported in full so parser tasks don't edit this file.
//!
//! Dictionaries are `(key, value)` slices **in upstream's key order**. It matters:
//! `match_any_pattern` sorts stably, so equal-length keys keep this order.

use std::sync::LazyLock;

use crate::calculation::duration::{Duration, DurationUnit};
use crate::calculation::years::find_most_likely_ad_year;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::js::{js_parse_float, js_parse_int, js_substring_from};
use crate::core::utils::pattern::{
    dict_get, dict_keys, js_len, match_any_pattern, repeated_timeunit_pattern, Dictionary,
};
use crate::js_regex;

pub static WEEKDAY_DICTIONARY: &Dictionary<i64> = &[
    ("zondag", 0),
    ("zon", 0),
    ("zon.", 0),
    ("zo", 0),
    ("zo.", 0),
    ("maandag", 1),
    ("ma", 1),
    ("ma.", 1),
    ("dinsdag", 2),
    ("din", 2),
    ("din.", 2),
    ("di", 2),
    ("di.", 2),
    ("woensdag", 3),
    ("woe", 3),
    ("woe.", 3),
    ("wo", 3),
    ("wo.", 3),
    ("donderdag", 4),
    ("dond", 4),
    ("dond.", 4),
    ("do", 4),
    ("do.", 4),
    ("vrijdag", 5),
    ("vrij", 5),
    ("vrij.", 5),
    ("vr", 5),
    ("vr.", 5),
    ("zaterdag", 6),
    ("zat", 6),
    ("zat.", 6),
    ("za", 6),
    ("za.", 6),
];

pub static MONTH_DICTIONARY: &Dictionary<i64> = &[
    ("januari", 1),
    ("jan", 1),
    ("jan.", 1),
    ("februari", 2),
    ("feb", 2),
    ("feb.", 2),
    ("maart", 3),
    ("mar", 3),
    ("mar.", 3),
    ("mrt", 3),
    ("mrt.", 3),
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
    ("augustus", 8),
    ("aug", 8),
    ("aug.", 8),
    ("september", 9),
    ("sep", 9),
    ("sep.", 9),
    ("sept", 9),
    ("sept.", 9),
    ("oktober", 10),
    ("okt", 10),
    ("okt.", 10),
    ("november", 11),
    ("nov", 11),
    ("nov.", 11),
    ("december", 12),
    ("dec", 12),
    ("dec.", 12),
];

pub static INTEGER_WORD_DICTIONARY: &Dictionary<i64> = &[
    ("een", 1),
    ("twee", 2),
    ("drie", 3),
    ("vier", 4),
    ("vijf", 5),
    ("zes", 6),
    ("zeven", 7),
    ("acht", 8),
    ("negen", 9),
    ("tien", 10),
    ("elf", 11),
    ("twaalf", 12),
];

pub static ORDINAL_WORD_DICTIONARY: &Dictionary<i64> = &[
    ("eerste", 1),
    ("tweede", 2),
    ("derde", 3),
    ("vierde", 4),
    ("vijfde", 5),
    ("zesde", 6),
    ("zevende", 7),
    ("achtste", 8),
    ("negende", 9),
    ("tiende", 10),
    ("elfde", 11),
    ("twaalfde", 12),
    ("dertiende", 13),
    ("veertiende", 14),
    ("vijftiende", 15),
    ("zestiende", 16),
    ("zeventiende", 17),
    ("achttiende", 18),
    ("negentiende", 19),
    ("twintigste", 20),
    ("eenentwintigste", 21),
    ("tweeëntwintigste", 22),
    ("drieentwintigste", 23),
    ("vierentwintigste", 24),
    ("vijfentwintigste", 25),
    ("zesentwintigste", 26),
    ("zevenentwintigste", 27),
    ("achtentwintig", 28),
    ("negenentwintig", 29),
    ("dertigste", 30),
    ("eenendertigste", 31),
];

pub static TIME_UNIT_DICTIONARY: &Dictionary<DurationUnit> = &[
    ("sec", DurationUnit::Second),
    ("second", DurationUnit::Second),
    ("seconden", DurationUnit::Second),
    ("min", DurationUnit::Minute),
    ("mins", DurationUnit::Minute),
    ("minute", DurationUnit::Minute),
    ("minuut", DurationUnit::Minute),
    ("minuten", DurationUnit::Minute),
    ("minuutje", DurationUnit::Minute),
    ("h", DurationUnit::Hour),
    ("hr", DurationUnit::Hour),
    ("hrs", DurationUnit::Hour),
    ("uur", DurationUnit::Hour),
    ("u", DurationUnit::Hour),
    ("uren", DurationUnit::Hour),
    ("dag", DurationUnit::Day),
    ("dagen", DurationUnit::Day),
    ("week", DurationUnit::Week),
    ("weken", DurationUnit::Week),
    ("maand", DurationUnit::Month),
    ("maanden", DurationUnit::Month),
    ("jaar", DurationUnit::Year),
    ("jr", DurationUnit::Year),
    ("jaren", DurationUnit::Year),
];

//-----------------------------

pub static NUMBER_PATTERN: LazyLock<String> = LazyLock::new(|| {
    format!(
        r"(?:{}|[0-9]+|[0-9]+[\.,][0-9]+|halve?|half|paar)",
        match_any_pattern(dict_keys(INTEGER_WORD_DICTIONARY))
    )
});

/// `parseNumberPattern(match)`. May be fractional (`half` = 0.5); `None` is `NaN`.
pub fn parse_number_pattern(m: &str) -> Option<f64> {
    let num = m.to_lowercase();
    if let Some(v) = dict_get(INTEGER_WORD_DICTIONARY, &num) {
        return Some(v as f64);
    } else if num == "paar" {
        return Some(2.0);
    } else if num == "half" || js_regex!(r"halve?").is_match(&num) {
        return Some(0.5);
    }
    // Replace "," with "." to support some European languages
    let n = js_parse_float(&num.replacen(',', ".", 1));
    (!n.is_nan()).then_some(n)
}

//-----------------------------

pub static ORDINAL_NUMBER_PATTERN: LazyLock<String> = LazyLock::new(|| {
    format!(
        r"(?:{}|[0-9]{{1,2}}(?:ste|de)?)",
        match_any_pattern(dict_keys(ORDINAL_WORD_DICTIONARY))
    )
});

/// `parseOrdinalNumberPattern(match)`. `None` is `NaN`.
pub fn parse_ordinal_number_pattern(m: &str) -> Option<i64> {
    let num = m.to_lowercase();
    if let Some(v) = dict_get(ORDINAL_WORD_DICTIONARY, &num) {
        return Some(v);
    }
    let num = num
        .strip_suffix("ste")
        .or_else(|| num.strip_suffix("de"))
        .unwrap_or(&num);
    js_parse_int(num)
}

//-----------------------------

pub const YEAR_PATTERN: &str = r"(?:[1-9][0-9]{0,3}\s*(?:voor Christus|na Christus)|[1-2][0-9]{3}|[5-9][0-9])";

/// `parseYear(match)`. `None` is `NaN`.
pub fn parse_year(m: &str) -> Option<i64> {
    let before = js_regex!(r"voor Christus", "i");
    if before.is_match(m) {
        // Before Christ
        return js_parse_int(&replace_first(before, m)).map(|y| -y);
    }

    let after = js_regex!(r"na Christus", "i");
    if after.is_match(m) {
        return js_parse_int(&replace_first(after, m));
    }

    js_parse_int(m).map(find_most_likely_ad_year)
}

/// `m.replace(re, "")` for a non-global `re`.
fn replace_first(re: &JsRegex, m: &str) -> String {
    match re.exec(m) {
        Some(found) => {
            let end = found.index + found.text().len();
            format!("{}{}", &m[..found.index], &m[end..])
        }
        None => m.to_string(),
    }
}

//-----------------------------

static SINGLE_TIME_UNIT_PATTERN: LazyLock<String> = LazyLock::new(|| {
    format!(
        r"({})\s{{0,5}}({})\s{{0,5}}",
        *NUMBER_PATTERN,
        match_any_pattern(dict_keys(TIME_UNIT_DICTIONARY))
    )
});

static SINGLE_TIME_UNIT_REGEX: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new(&SINGLE_TIME_UNIT_PATTERN, "i"));

pub static TIME_UNITS_PATTERN: LazyLock<String> =
    LazyLock::new(|| repeated_timeunit_pattern(r"(?:(?:binnen|in)\s*)?", &SINGLE_TIME_UNIT_PATTERN, None));

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
    let num = parse_number_pattern(m.get(1).unwrap_or("")).unwrap_or(f64::NAN);
    // The regex only matches dictionary keys, so the lookup always succeeds.
    if let Some(unit) = dict_get(TIME_UNIT_DICTIONARY, &m.get(2).unwrap_or("").to_lowercase()) {
        fragments.set(unit, num);
    }
}

#[cfg(test)]
mod tests {
    //! Expected values come from the contract's cases, recorded from the pinned chrono-node.
    use super::*;
    use DurationUnit::*;

    fn entries<T: Copy + PartialEq + std::fmt::Debug>(d: &Dictionary<T>, expect: &[(&str, T)]) {
        assert_eq!(d.len(), expect.len());
        for (k, v) in expect {
            assert_eq!(dict_get(d, k), Some(*v), "{k}");
        }
    }

    #[test]
    fn weekday_dictionary_matches_upstream() {
        let words = [
            ("zondag", 0),
            ("zon", 0),
            ("zon.", 0),
            ("zo", 0),
            ("zo.", 0),
            ("maandag", 1),
            ("ma", 1),
            ("ma.", 1),
            ("dinsdag", 2),
            ("din", 2),
            ("din.", 2),
            ("di", 2),
            ("di.", 2),
            ("woensdag", 3),
            ("woe", 3),
            ("woe.", 3),
            ("wo", 3),
            ("wo.", 3),
            ("donderdag", 4),
            ("dond", 4),
            ("dond.", 4),
            ("do", 4),
            ("do.", 4),
            ("vrijdag", 5),
            ("vrij", 5),
            ("vrij.", 5),
            ("vr", 5),
            ("vr.", 5),
            ("zaterdag", 6),
            ("zat", 6),
            ("zat.", 6),
            ("za", 6),
            ("za.", 6),
        ];
        entries(WEEKDAY_DICTIONARY, &words);
    }

    #[test]
    fn month_dictionary_matches_upstream() {
        let words = [
            ("januari", 1),
            ("jan", 1),
            ("jan.", 1),
            ("februari", 2),
            ("feb", 2),
            ("feb.", 2),
            ("maart", 3),
            ("mar", 3),
            ("mar.", 3),
            ("mrt", 3),
            ("mrt.", 3),
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
            ("augustus", 8),
            ("aug", 8),
            ("aug.", 8),
            ("september", 9),
            ("sep", 9),
            ("sep.", 9),
            ("sept", 9),
            ("sept.", 9),
            ("oktober", 10),
            ("okt", 10),
            ("okt.", 10),
            ("november", 11),
            ("nov", 11),
            ("nov.", 11),
            ("december", 12),
            ("dec", 12),
            ("dec.", 12),
        ];
        entries(MONTH_DICTIONARY, &words);
    }

    #[test]
    fn integer_word_dictionary_matches_upstream() {
        let words = [
            ("een", 1),
            ("twee", 2),
            ("drie", 3),
            ("vier", 4),
            ("vijf", 5),
            ("zes", 6),
            ("zeven", 7),
            ("acht", 8),
            ("negen", 9),
            ("tien", 10),
            ("elf", 11),
            ("twaalf", 12),
        ];
        entries(INTEGER_WORD_DICTIONARY, &words);
    }

    #[test]
    fn ordinal_word_dictionary_matches_upstream() {
        let words = [
            ("eerste", 1),
            ("tweede", 2),
            ("derde", 3),
            ("vierde", 4),
            ("vijfde", 5),
            ("zesde", 6),
            ("zevende", 7),
            ("achtste", 8),
            ("negende", 9),
            ("tiende", 10),
            ("elfde", 11),
            ("twaalfde", 12),
            ("dertiende", 13),
            ("veertiende", 14),
            ("vijftiende", 15),
            ("zestiende", 16),
            ("zeventiende", 17),
            ("achttiende", 18),
            ("negentiende", 19),
            ("twintigste", 20),
            ("eenentwintigste", 21),
            ("tweeëntwintigste", 22),
            ("drieentwintigste", 23),
            ("vierentwintigste", 24),
            ("vijfentwintigste", 25),
            ("zesentwintigste", 26),
            ("zevenentwintigste", 27),
            ("achtentwintig", 28),
            ("negenentwintig", 29),
            ("dertigste", 30),
            ("eenendertigste", 31),
        ];
        entries(ORDINAL_WORD_DICTIONARY, &words);
    }

    #[test]
    fn time_unit_dictionary_matches_upstream() {
        let words = [
            ("sec", Second),
            ("second", Second),
            ("seconden", Second),
            ("min", Minute),
            ("mins", Minute),
            ("minute", Minute),
            ("minuut", Minute),
            ("minuten", Minute),
            ("minuutje", Minute),
            ("h", Hour),
            ("hr", Hour),
            ("hrs", Hour),
            ("uur", Hour),
            ("u", Hour),
            ("uren", Hour),
            ("dag", Day),
            ("dagen", Day),
            ("week", Week),
            ("weken", Week),
            ("maand", Month),
            ("maanden", Month),
            ("jaar", Year),
            ("jr", Year),
            ("jaren", Year),
        ];
        entries(TIME_UNIT_DICTIONARY, &words);
    }

    #[test]
    fn number_pattern_matches_upstream() {
        assert_eq!(
            *NUMBER_PATTERN,
            r"(?:(?:twaalf|zeven|negen|twee|drie|vier|vijf|acht|tien|een|zes|elf)|[0-9]+|[0-9]+[\.,][0-9]+|halve?|half|paar)"
        );
    }

    fn num(s: &str, expect: Option<f64>) {
        assert_eq!(parse_number_pattern(s), expect, "{s}");
    }

    #[test]
    fn parse_number_pattern_case_1() {
        num("1", Some(1.0));
    }
    #[test]
    fn parse_number_pattern_case_2() {
        num("h", None);
    }
    #[test]
    fn parse_number_pattern_case_3() {
        num("2", Some(2.0));
    }
    #[test]
    fn parse_number_pattern_case_4() {
        num("3", Some(3.0));
    }
    #[test]
    fn parse_number_pattern_case_5() {
        num("een", Some(1.0));
    }
    #[test]
    fn parse_number_pattern_case_6() {
        num("elf", Some(11.0));
    }
    #[test]
    fn parse_number_pattern_case_7() {
        num("1u ", Some(1.0));
    }
    #[test]
    fn parse_number_pattern_case_8() {
        num("3jr", Some(3.0));
    }

    #[test]
    fn ordinal_number_pattern_matches_upstream() {
        assert_eq!(
            *ORDINAL_NUMBER_PATTERN,
            r"(?:(?:zevenentwintigste|tweeëntwintigste|drieentwintigste|vierentwintigste|vijfentwintigste|eenentwintigste|zesentwintigste|negenentwintig|eenendertigste|achtentwintig|zeventiende|negentiende|veertiende|vijftiende|achttiende|twintigste|dertiende|zestiende|dertigste|twaalfde|zevende|achtste|negende|eerste|tweede|vierde|vijfde|tiende|derde|zesde|elfde)|[0-9]{1,2}(?:ste|de)?)"
        );
    }

    fn ord(s: &str, expect: Option<i64>) {
        assert_eq!(parse_ordinal_number_pattern(s), expect, "{s}");
    }

    #[test]
    fn parse_ordinal_number_pattern_case_1() {
        ord("1", Some(1));
    }
    #[test]
    fn parse_ordinal_number_pattern_case_2() {
        ord("h", None);
    }
    #[test]
    fn parse_ordinal_number_pattern_case_3() {
        ord("2", Some(2));
    }
    #[test]
    fn parse_ordinal_number_pattern_case_4() {
        ord("3", Some(3));
    }
    #[test]
    fn parse_ordinal_number_pattern_case_5() {
        ord("1u ", Some(1));
    }
    #[test]
    fn parse_ordinal_number_pattern_case_6() {
        ord("3jr", Some(3));
    }
    #[test]
    fn parse_ordinal_number_pattern_case_7() {
        ord("12de", Some(12));
    }
    #[test]
    fn parse_ordinal_number_pattern_case_8() {
        ord("elfde", Some(11));
    }

    #[test]
    fn year_pattern_matches_upstream() {
        assert_eq!(
            YEAR_PATTERN,
            r"(?:[1-9][0-9]{0,3}\s*(?:voor Christus|na Christus)|[1-2][0-9]{3}|[5-9][0-9])"
        );
    }

    fn year(s: &str, expect: Option<i64>) {
        assert_eq!(parse_year(s), expect, "{s}");
    }

    #[test]
    fn parse_year_case_1() {
        year("1", Some(2001));
    }
    #[test]
    fn parse_year_case_2() {
        year("h", None);
    }
    #[test]
    fn parse_year_case_3() {
        year("2", Some(2002));
    }
    #[test]
    fn parse_year_case_4() {
        year("3", Some(2003));
    }
    #[test]
    fn parse_year_case_5() {
        year("1u ", Some(2001));
    }
    #[test]
    fn parse_year_case_6() {
        year("3jr", Some(2003));
    }
    #[test]
    fn parse_year_case_7() {
        year("12de", Some(2012));
    }

    #[test]
    fn time_units_pattern_matches_upstream() {
        let number = r"(?:(?:twaalf|zeven|negen|twee|drie|vier|vijf|acht|tien|een|zes|elf)|[0-9]+|[0-9]+[\.,][0-9]+|halve?|half|paar)";
        let units = r"(?:(?:seconden|minuutje|minuten|maanden|second|minute|minuut|dagen|weken|maand|jaren|mins|uren|week|jaar|sec|min|hrs|uur|dag|hr|jr|h|u))";
        let single = format!(r"(?:{number})\s{{0,5}}{units}\s{{0,5}}");
        assert_eq!(
            *TIME_UNITS_PATTERN,
            format!(r"(?:(?:binnen|in)\s*)?{single}(?:\s{{0,5}},?\s{{0,5}}{single}){{0,10}}")
        );
    }

    fn dur(s: &str, pairs: &[(DurationUnit, f64)]) {
        assert_eq!(parse_duration(s), Duration::from_pairs(pairs), "{s}");
    }

    #[test]
    fn parse_duration_case_1() {
        dur("1", &[]);
    }
    #[test]
    fn parse_duration_case_2() {
        dur("1u ", &[(Hour, 1.0)]);
    }
    #[test]
    fn parse_duration_case_3() {
        dur("3jr", &[(Year, 3.0)]);
    }
    #[test]
    fn parse_duration_case_4() {
        dur("15min", &[(Minute, 15.0)]);
    }
    #[test]
    fn parse_duration_case_5() {
        dur("Een dag ", &[(Day, 1.0)]);
    }
    #[test]
    fn parse_duration_case_6() {
        dur("paar uur", &[(Hour, 2.0)]);
    }
    #[test]
    fn parse_duration_case_7() {
        dur("een week ", &[(Week, 1.0)]);
    }
}
