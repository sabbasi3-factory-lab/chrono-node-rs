//! upstream `locales/de/constants.ts`. Ported in full so parser tasks don't edit this file.
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
    ("sonntag", 0),
    ("so", 0),
    ("montag", 1),
    ("mo", 1),
    ("dienstag", 2),
    ("di", 2),
    ("mittwoch", 3),
    ("mi", 3),
    ("donnerstag", 4),
    ("do", 4),
    ("freitag", 5),
    ("fr", 5),
    ("samstag", 6),
    ("sa", 6),
];

pub static MONTH_DICTIONARY: &Dictionary<i64> = &[
    ("januar", 1),
    ("jänner", 1),
    ("janner", 1),
    ("jan", 1),
    ("jan.", 1),
    ("februar", 2),
    ("feber", 2),
    ("feb", 2),
    ("feb.", 2),
    ("märz", 3),
    ("maerz", 3),
    ("mär", 3),
    ("mär.", 3),
    ("mrz", 3),
    ("mrz.", 3),
    ("april", 4),
    ("apr", 4),
    ("apr.", 4),
    ("mai", 5),
    ("juni", 6),
    ("jun", 6),
    ("jun.", 6),
    ("juli", 7),
    ("jul", 7),
    ("jul.", 7),
    ("august", 8),
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
    ("dezember", 12),
    ("dez", 12),
    ("dez.", 12),
];

pub static INTEGER_WORD_DICTIONARY: &Dictionary<i64> = &[
    ("eins", 1),
    ("eine", 1),
    ("einem", 1),
    ("einen", 1),
    ("einer", 1),
    ("zwei", 2),
    ("drei", 3),
    ("vier", 4),
    ("fünf", 5),
    ("fuenf", 5),
    ("sechs", 6),
    ("sieben", 7),
    ("acht", 8),
    ("neun", 9),
    ("zehn", 10),
    ("elf", 11),
    ("zwölf", 12),
    ("zwoelf", 12),
];

pub static TIME_UNIT_DICTIONARY: &Dictionary<DurationUnit> = &[
    ("sek", DurationUnit::Second),
    ("sekunde", DurationUnit::Second),
    ("sekunden", DurationUnit::Second),
    ("min", DurationUnit::Minute),
    ("minute", DurationUnit::Minute),
    ("minuten", DurationUnit::Minute),
    ("h", DurationUnit::Hour),
    ("std", DurationUnit::Hour),
    ("stunde", DurationUnit::Hour),
    ("stunden", DurationUnit::Hour),
    ("tag", DurationUnit::Day),
    ("tage", DurationUnit::Day),
    ("tagen", DurationUnit::Day),
    ("woche", DurationUnit::Week),
    ("wochen", DurationUnit::Week),
    ("monat", DurationUnit::Month),
    ("monate", DurationUnit::Month),
    ("monaten", DurationUnit::Month),
    ("monats", DurationUnit::Month),
    ("quartal", DurationUnit::Quarter),
    ("quartals", DurationUnit::Quarter),
    ("quartale", DurationUnit::Quarter),
    ("quartalen", DurationUnit::Quarter),
    ("a", DurationUnit::Year),
    ("j", DurationUnit::Year),
    ("jr", DurationUnit::Year),
    ("jahr", DurationUnit::Year),
    ("jahre", DurationUnit::Year),
    ("jahren", DurationUnit::Year),
    ("jahres", DurationUnit::Year),
];

//-----------------------------

pub static NUMBER_PATTERN: LazyLock<String> = LazyLock::new(|| {
    format!(
        r"(?:{}|[0-9]+|[0-9]+\.[0-9]+|halb?|halbe?|einigen?|wenigen?|mehreren?)",
        match_any_pattern(dict_keys(INTEGER_WORD_DICTIONARY))
    )
});

/// `parseNumberPattern(match)`. May be fractional (`halb` = 0.5) or `NaN`.
pub fn parse_number_pattern(m: &str) -> f64 {
    let num = m.to_lowercase();
    if let Some(v) = dict_get(INTEGER_WORD_DICTIONARY, &num) {
        return v as f64;
    }
    if num == "ein" || num == "einer" || num == "einem" || num == "einen" || num == "eine" {
        return 1.0;
    }
    if num.contains("wenigen") {
        return 2.0;
    }
    if num.contains("halb") || num.contains("halben") {
        return 0.5;
    }
    if num.contains("einigen") {
        return 3.0;
    }
    if num.contains("mehreren") {
        return 7.0;
    }
    js_parse_float(&num)
}

//-----------------------------

pub const YEAR_PATTERN: &str = r"(?:[0-9]{1,4}(?:\s*[vn]\.?\s*(?:C(?:hr)?|(?:u\.?|d\.?(?:\s*g\.?)?)?\s*Z)\.?|\s*(?:u\.?|d\.?(?:\s*g\.)?)\s*Z\.?)?)";

/// `match.replace(/[^0-9]+/gi, "")`: every non-digit removed.
fn digits_only(m: &str) -> String {
    m.chars().filter(|c| c.is_ascii_digit()).collect()
}

/// `parseYear(match)`. `None` is `NaN`.
pub fn parse_year(m: &str) -> Option<i64> {
    if js_regex!(r"v", "i").is_match(m) {
        // v.Chr.
        return js_parse_int(&digits_only(m)).map(|y| -y);
    }
    if js_regex!(r"n", "i").is_match(m) {
        // n.Chr.
        return js_parse_int(&digits_only(m));
    }
    if js_regex!(r"z", "i").is_match(m) {
        // n.Chr. as "uZ" or "dgZ"
        return js_parse_int(&digits_only(m));
    }
    js_parse_int(m).map(find_most_likely_ad_year)
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
    LazyLock::new(|| repeated_timeunit_pattern("", &SINGLE_TIME_UNIT_PATTERN, None));

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

    #[test]
    fn patterns_match_upstream_exactly() {
        let number = r"(?:(?:sieben|zwoelf|einem|einen|einer|fuenf|sechs|zwölf|eins|eine|zwei|drei|vier|fünf|acht|neun|zehn|elf)|[0-9]+|[0-9]+\.[0-9]+|halb?|halbe?|einigen?|wenigen?|mehreren?)";
        assert_eq!(*NUMBER_PATTERN, number);
        let units = r"(?:(?:quartalen|sekunden|quartals|quartale|sekunde|minuten|stunden|monaten|quartal|minute|stunde|wochen|monate|monats|jahren|jahres|tagen|woche|monat|jahre|tage|jahr|sek|min|std|tag|jr|h|a|j))";
        let single = format!(r"(?:{number})\s{{0,5}}{units}\s{{0,5}}");
        assert_eq!(
            *TIME_UNITS_PATTERN,
            format!(r"{single}(?:\s{{0,5}},?\s{{0,5}}{single}){{0,10}}")
        );
        for p in [&*NUMBER_PATTERN, &*TIME_UNITS_PATTERN, YEAR_PATTERN] {
            JsRegex::new(p, "i");
        }
    }

    #[test]
    fn numbers() {
        for (s, v) in [
            ("eins", 1.0),
            ("Eine", 1.0),
            ("einer", 1.0),
            ("ein", 1.0),
            ("zwölf", 12.0),
            ("ZWOELF", 12.0),
            ("2.5", 2.5),
            ("12", 12.0),
            ("halb", 0.5),
            ("halbe", 0.5),
            ("wenigen", 2.0),
            ("einigen", 3.0),
            ("mehreren", 7.0),
            ("3x", 3.0),
        ] {
            assert_eq!(parse_number_pattern(s), v, "{s}");
        }
        for s in ["hal", "wenige", "einige", "mehrere"] {
            assert!(parse_number_pattern(s).is_nan(), "{s}");
        }
    }

    #[test]
    fn years() {
        for (s, v) in [
            ("2012", Some(2012)),
            ("97", Some(1997)),
            ("12", Some(2012)),
            ("50 v. Chr.", Some(-50)),
            ("300 n. Chr.", Some(300)),
            ("1000 v.C", Some(-1000)),
            ("88 uZ", Some(88)),
            ("88 dgZ", Some(88)),
            ("88 d. g. Z.", Some(88)),
            ("20 N.Chr", Some(20)),
            ("abc", None),
            ("v", None),
        ] {
            assert_eq!(parse_year(s), v, "{s}");
        }
    }

    #[test]
    fn durations() {
        let d = |pairs: &[(DurationUnit, f64)]| Duration::from_pairs(pairs);
        assert_eq!(parse_duration("5 Tage"), d(&[(Day, 5.0)]));
        assert_eq!(
            parse_duration("2 Stunden 30 Minuten"),
            d(&[(Hour, 2.0), (Minute, 30.0)])
        );
        assert_eq!(parse_duration("einen Monat"), d(&[(Month, 1.0)]));
        assert_eq!(parse_duration("halbe Stunde"), d(&[(Hour, 0.5)]));
        assert_eq!(parse_duration("3h 20min"), d(&[(Hour, 3.0), (Minute, 20.0)]));
        assert_eq!(parse_duration("1 Jahr, 2 Monate"), d(&[(Year, 1.0), (Month, 2.0)]));
        assert_eq!(parse_duration("Tage"), Duration::new());
        assert_eq!(parse_duration("5 Tage 6 Tage"), d(&[(Day, 6.0)]));
        let nan = parse_duration("mehrere Wochen");
        assert!(nan.get(Week).is_some_and(f64::is_nan) && nan.iter().count() == 1);
    }
}
