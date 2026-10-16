//! upstream `locales/en/constants.ts`. Ported in full so parser tasks don't edit this file.
//!
//! Dictionaries are `(key, value)` slices **in upstream's key order**. It matters:
//! `match_any_pattern` sorts stably, so equal-length keys keep this order.

use std::sync::LazyLock;

use crate::calculation::duration::{Duration, DurationUnit};
use crate::calculation::years::find_most_likely_ad_year;
use crate::core::utils::js::{js_parse_float, js_parse_int, js_substring_from, js_trim};
use crate::core::utils::pattern::{
    dict_get, dict_keys, js_len, match_any_pattern, repeated_timeunit_pattern, Dictionary,
};
use crate::js_regex;

pub static WEEKDAY_DICTIONARY: &Dictionary<i64> = &[
    ("sunday", 0),
    ("sun", 0),
    ("sun.", 0),
    ("monday", 1),
    ("mon", 1),
    ("mon.", 1),
    ("tuesday", 2),
    ("tue", 2),
    ("tue.", 2),
    ("wednesday", 3),
    ("wed", 3),
    ("wed.", 3),
    ("thursday", 4),
    ("thurs", 4),
    ("thurs.", 4),
    ("thur", 4),
    ("thur.", 4),
    ("thu", 4),
    ("thu.", 4),
    ("friday", 5),
    ("fri", 5),
    ("fri.", 5),
    ("saturday", 6),
    ("sat", 6),
    ("sat.", 6),
];

pub static FULL_MONTH_NAME_DICTIONARY: &Dictionary<i64> = &[
    ("january", 1),
    ("february", 2),
    ("march", 3),
    ("april", 4),
    ("may", 5),
    ("june", 6),
    ("july", 7),
    ("august", 8),
    ("september", 9),
    ("october", 10),
    ("november", 11),
    ("december", 12),
];

/// `{ ...FULL_MONTH_NAME_DICTIONARY, jan: 1, ... }`.
pub static MONTH_DICTIONARY: &Dictionary<i64> = &[
    ("january", 1),
    ("february", 2),
    ("march", 3),
    ("april", 4),
    ("may", 5),
    ("june", 6),
    ("july", 7),
    ("august", 8),
    ("september", 9),
    ("october", 10),
    ("november", 11),
    ("december", 12),
    ("jan", 1),
    ("jan.", 1),
    ("feb", 2),
    ("feb.", 2),
    ("mar", 3),
    ("mar.", 3),
    ("apr", 4),
    ("apr.", 4),
    ("jun", 6),
    ("jun.", 6),
    ("jul", 7),
    ("jul.", 7),
    ("aug", 8),
    ("aug.", 8),
    ("sep", 9),
    ("sep.", 9),
    ("sept", 9),
    ("sept.", 9),
    ("oct", 10),
    ("oct.", 10),
    ("nov", 11),
    ("nov.", 11),
    ("dec", 12),
    ("dec.", 12),
];

pub static INTEGER_WORD_DICTIONARY: &Dictionary<i64> = &[
    ("one", 1),
    ("two", 2),
    ("three", 3),
    ("four", 4),
    ("five", 5),
    ("six", 6),
    ("seven", 7),
    ("eight", 8),
    ("nine", 9),
    ("ten", 10),
    ("eleven", 11),
    ("twelve", 12),
];

pub static ORDINAL_WORD_DICTIONARY: &Dictionary<i64> = &[
    ("first", 1),
    ("second", 2),
    ("third", 3),
    ("fourth", 4),
    ("fifth", 5),
    ("sixth", 6),
    ("seventh", 7),
    ("eighth", 8),
    ("ninth", 9),
    ("tenth", 10),
    ("eleventh", 11),
    ("twelfth", 12),
    ("thirteenth", 13),
    ("fourteenth", 14),
    ("fifteenth", 15),
    ("sixteenth", 16),
    ("seventeenth", 17),
    ("eighteenth", 18),
    ("nineteenth", 19),
    ("twentieth", 20),
    ("twenty first", 21),
    ("twenty-first", 21),
    ("twenty second", 22),
    ("twenty-second", 22),
    ("twenty third", 23),
    ("twenty-third", 23),
    ("twenty fourth", 24),
    ("twenty-fourth", 24),
    ("twenty fifth", 25),
    ("twenty-fifth", 25),
    ("twenty sixth", 26),
    ("twenty-sixth", 26),
    ("twenty seventh", 27),
    ("twenty-seventh", 27),
    ("twenty eighth", 28),
    ("twenty-eighth", 28),
    ("twenty ninth", 29),
    ("twenty-ninth", 29),
    ("thirtieth", 30),
    ("thirty first", 31),
    ("thirty-first", 31),
];

pub static TIME_UNIT_DICTIONARY_NO_ABBR: &Dictionary<DurationUnit> = &[
    ("second", DurationUnit::Second),
    ("seconds", DurationUnit::Second),
    ("minute", DurationUnit::Minute),
    ("minutes", DurationUnit::Minute),
    ("hour", DurationUnit::Hour),
    ("hours", DurationUnit::Hour),
    ("day", DurationUnit::Day),
    ("days", DurationUnit::Day),
    ("week", DurationUnit::Week),
    ("weeks", DurationUnit::Week),
    ("month", DurationUnit::Month),
    ("months", DurationUnit::Month),
    ("quarter", DurationUnit::Quarter),
    ("quarters", DurationUnit::Quarter),
    ("year", DurationUnit::Year),
    ("years", DurationUnit::Year),
];

/// Upstream spreads `TIME_UNIT_DICTIONARY_NO_ABBR` at the end, but every key already exists,
/// so the JS key order is just the abbreviated list below.
pub static TIME_UNIT_DICTIONARY: &Dictionary<DurationUnit> = &[
    ("s", DurationUnit::Second),
    ("sec", DurationUnit::Second),
    ("second", DurationUnit::Second),
    ("seconds", DurationUnit::Second),
    ("m", DurationUnit::Minute),
    ("min", DurationUnit::Minute),
    ("mins", DurationUnit::Minute),
    ("minute", DurationUnit::Minute),
    ("minutes", DurationUnit::Minute),
    ("h", DurationUnit::Hour),
    ("hr", DurationUnit::Hour),
    ("hrs", DurationUnit::Hour),
    ("hour", DurationUnit::Hour),
    ("hours", DurationUnit::Hour),
    ("d", DurationUnit::Day),
    ("day", DurationUnit::Day),
    ("days", DurationUnit::Day),
    ("w", DurationUnit::Week),
    ("week", DurationUnit::Week),
    ("weeks", DurationUnit::Week),
    ("mo", DurationUnit::Month),
    ("mon", DurationUnit::Month),
    ("mos", DurationUnit::Month),
    ("month", DurationUnit::Month),
    ("months", DurationUnit::Month),
    ("qtr", DurationUnit::Quarter),
    ("quarter", DurationUnit::Quarter),
    ("quarters", DurationUnit::Quarter),
    ("y", DurationUnit::Year),
    ("yr", DurationUnit::Year),
    ("year", DurationUnit::Year),
    ("years", DurationUnit::Year),
];

//-----------------------------

pub static NUMBER_PATTERN: LazyLock<String> = LazyLock::new(|| {
    format!(
        r"(?:{}|[0-9]+|[0-9]+\.[0-9]+|half(?:\s{{0,2}}an?)?|an?\b(?:\s{{0,2}}few)?|few|several|the|a?\s{{0,2}}couple\s{{0,2}}(?:of)?)",
        match_any_pattern(dict_keys(INTEGER_WORD_DICTIONARY))
    )
});

/// `parseNumberPattern(match)`. May be fractional (`half` = 0.5) or `NaN`.
pub fn parse_number_pattern(m: &str) -> f64 {
    let num = m.to_lowercase();
    if let Some(v) = dict_get(INTEGER_WORD_DICTIONARY, &num) {
        return v as f64;
    }
    if num == "a" || num == "an" || num == "the" {
        return 1.0;
    }
    if num.contains("few") {
        return 3.0;
    }
    if num.contains("half") {
        return 0.5;
    }
    if num.contains("couple") {
        return 2.0;
    }
    if num.contains("several") {
        return 7.0;
    }
    js_parse_float(&num)
}

//-----------------------------

pub static ORDINAL_NUMBER_PATTERN: LazyLock<String> = LazyLock::new(|| {
    format!(
        r"(?:{}|[0-9]{{1,2}}(?:st|nd|rd|th)?)",
        match_any_pattern(dict_keys(ORDINAL_WORD_DICTIONARY))
    )
});

/// `parseOrdinalNumberPattern(match)`. `None` is `NaN`.
pub fn parse_ordinal_number_pattern(m: &str) -> Option<i64> {
    let num = m.to_lowercase();
    if let Some(v) = dict_get(ORDINAL_WORD_DICTIONARY, &num) {
        return Some(v);
    }
    let stripped = js_regex!(r"(?:st|nd|rd|th)$", "i")
        .exec(&num)
        .map_or(num.as_str(), |mm| &num[..mm.index]);
    js_parse_int(stripped)
}

//-----------------------------

pub const YEAR_PATTERN: &str = r"(?:[1-9][0-9]{0,3}\s{0,2}(?:BE|AD|BC|BCE|CE)|[1-9][0-9]{3}|[0-9]{2}(?!\w|:\d|\s+(?:am|pm|o\s*clock|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)))";

/// `match.replace(regex, "")` for a non-global regex: removes the first match only.
fn replace_first(text: &str, m: Option<crate::core::regex::RegexMatch>) -> String {
    match m {
        Some(m) => format!("{}{}", &text[..m.index], &text[m.index + m.text().len()..]),
        None => text.to_string(),
    }
}

/// `parseYear(match)`. `None` is `NaN`.
pub fn parse_year(m: &str) -> Option<i64> {
    let be = js_regex!(r"BE", "i");
    if be.is_match(m) {
        // Buddhist Era
        return js_parse_int(&replace_first(m, be.exec(m))).map(|y| y - 543);
    }
    let bc = js_regex!(r"BCE?", "i");
    if bc.is_match(m) {
        // Before Christ, Before Common Era
        return js_parse_int(&replace_first(m, bc.exec(m))).map(|y| -y);
    }
    let ad = js_regex!(r"(AD|CE)", "i");
    if ad.is_match(m) {
        // Anno Domini, Common Era
        return js_parse_int(&replace_first(m, ad.exec(m)));
    }
    js_parse_int(m).map(find_most_likely_ad_year)
}

//-----------------------------

static SINGLE_TIME_UNIT_PATTERN: LazyLock<String> = LazyLock::new(|| {
    format!(
        r"({})\s{{0,3}}({})",
        *NUMBER_PATTERN,
        match_any_pattern(dict_keys(TIME_UNIT_DICTIONARY))
    )
});

static SINGLE_TIME_UNIT_REGEX: LazyLock<crate::core::regex::JsRegex> =
    LazyLock::new(|| crate::core::regex::JsRegex::new(&SINGLE_TIME_UNIT_PATTERN, "i"));

static SINGLE_TIME_UNIT_NO_ABBR_PATTERN: LazyLock<String> = LazyLock::new(|| {
    format!(
        r"({})\s{{0,3}}({})",
        *NUMBER_PATTERN,
        match_any_pattern(dict_keys(TIME_UNIT_DICTIONARY_NO_ABBR))
    )
});

const TIME_UNIT_CONNECTOR_PATTERN: &str = r"\s{0,5},?(?:\s*and)?\s{0,5}";

pub static TIME_UNITS_PATTERN: LazyLock<String> = LazyLock::new(|| {
    repeated_timeunit_pattern(
        r"(?:(?:about|around)\s{0,3})?",
        &SINGLE_TIME_UNIT_PATTERN,
        Some(TIME_UNIT_CONNECTOR_PATTERN),
    )
});

pub static TIME_UNITS_NO_ABBR_PATTERN: LazyLock<String> = LazyLock::new(|| {
    repeated_timeunit_pattern(
        r"(?:(?:about|around)\s{0,3})?",
        &SINGLE_TIME_UNIT_NO_ABBR_PATTERN,
        Some(TIME_UNIT_CONNECTOR_PATTERN),
    )
});

/// `parseDuration(timeunitText)`.
pub fn parse_duration(timeunit_text: &str) -> Option<Duration> {
    let mut fragments = Duration::new();
    let mut remaining = timeunit_text.to_string();
    let mut found = SINGLE_TIME_UNIT_REGEX.exec(&remaining);
    while let Some(m) = found {
        collect_date_time_fragment(&mut fragments, &m);
        // Upstream cuts `match[0].length` units from the *start*, not from the match position.
        remaining = js_trim(js_substring_from(&remaining, js_len(m.text()))).to_string();
        found = SINGLE_TIME_UNIT_REGEX.exec(&remaining);
    }
    if fragments.is_empty() {
        None
    } else {
        Some(fragments)
    }
}

fn collect_date_time_fragment(fragments: &mut Duration, m: &crate::core::regex::RegexMatch) {
    if js_regex!(r"^[a-zA-Z]+$").is_match(m.text()) {
        return;
    }
    let num = parse_number_pattern(m.get(1).unwrap_or(""));
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
        assert_eq!(
            *NUMBER_PATTERN,
            r"(?:(?:eleven|twelve|three|seven|eight|four|five|nine|one|two|six|ten)|[0-9]+|[0-9]+\.[0-9]+|half(?:\s{0,2}an?)?|an?\b(?:\s{0,2}few)?|few|several|the|a?\s{0,2}couple\s{0,2}(?:of)?)"
        );
        assert_eq!(
            *ORDINAL_NUMBER_PATTERN,
            r"(?:(?:twenty seventh|twenty-seventh|twenty second|twenty-second|twenty fourth|twenty-fourth|twenty eighth|twenty-eighth|twenty first|twenty-first|twenty third|twenty-third|twenty fifth|twenty-fifth|twenty sixth|twenty-sixth|twenty ninth|twenty-ninth|thirty first|thirty-first|seventeenth|thirteenth|fourteenth|eighteenth|nineteenth|fifteenth|sixteenth|twentieth|thirtieth|eleventh|seventh|twelfth|second|fourth|eighth|first|third|fifth|sixth|ninth|tenth)|[0-9]{1,2}(?:st|nd|rd|th)?)"
        );
        let units = r"(?:(?:quarters|seconds|minutes|quarter|second|minute|months|hours|weeks|month|years|mins|hour|days|week|year|sec|min|hrs|day|mon|mos|qtr|hr|mo|yr|s|m|h|d|w|y))";
        let single = format!(r"(?:{})\s{{0,3}}{units}", *NUMBER_PATTERN);
        assert_eq!(
            *TIME_UNITS_PATTERN,
            format!(r"(?:(?:about|around)\s{{0,3}})?{single}(?:\s{{0,5}},?(?:\s*and)?\s{{0,5}}{single}){{0,10}}")
        );
        let units_no_abbr = r"(?:(?:quarters|seconds|minutes|quarter|second|minute|months|hours|weeks|month|years|hour|days|week|year|day))";
        let single = format!(r"(?:{})\s{{0,3}}{units_no_abbr}", *NUMBER_PATTERN);
        assert_eq!(
            *TIME_UNITS_NO_ABBR_PATTERN,
            format!(r"(?:(?:about|around)\s{{0,3}})?{single}(?:\s{{0,5}},?(?:\s*and)?\s{{0,5}}{single}){{0,10}}")
        );
        for p in [
            &*NUMBER_PATTERN,
            &*ORDINAL_NUMBER_PATTERN,
            &*TIME_UNITS_PATTERN,
            &*TIME_UNITS_NO_ABBR_PATTERN,
            YEAR_PATTERN,
        ] {
            crate::core::regex::JsRegex::new(p, "i");
        }
    }

    #[test]
    fn numbers() {
        for (s, v) in [
            ("one", 1.0),
            ("An", 1.0),
            ("the", 1.0),
            ("a few", 3.0),
            ("half an", 0.5),
            ("couple of", 2.0),
            ("several", 7.0),
            ("2.5", 2.5),
            ("12", 12.0),
            ("twelve", 12.0),
            ("3.75", 3.75),
        ] {
            assert_eq!(parse_number_pattern(s), v, "{s}");
        }
        for (s, v) in [("first", 1), ("twenty-first", 21), ("3rd", 3), ("22nd", 22), ("31", 31)] {
            assert_eq!(parse_ordinal_number_pattern(s), Some(v), "{s}");
        }
    }

    #[test]
    fn years() {
        for (s, v) in [
            ("2012", 2012),
            ("97", 1997),
            ("12", 2012),
            ("2555 BE", 2012),
            ("500 BC", -500),
            ("100BCE", -100),
            ("300 AD", 300),
            ("5 CE", 5),
        ] {
            assert_eq!(parse_year(s), Some(v), "{s}");
        }
    }

    #[test]
    fn durations() {
        let d = |pairs: &[(DurationUnit, f64)]| Some(Duration::from_pairs(pairs));
        assert_eq!(parse_duration("5 days"), d(&[(Day, 5.0)]));
        assert_eq!(
            parse_duration("2 hours and 30 minutes"),
            d(&[(Hour, 2.0), (Minute, 30.0)])
        );
        assert_eq!(parse_duration("a few weeks"), d(&[(Week, 3.0)]));
        assert_eq!(parse_duration("half an hour"), d(&[(Hour, 0.5)]));
        assert_eq!(parse_duration("1.5 years, 3 months"), d(&[(Year, 1.5), (Month, 3.0)]));
        assert_eq!(parse_duration("3h 20m"), d(&[(Hour, 3.0), (Minute, 20.0)]));
        assert_eq!(parse_duration("an hour 2 mins"), d(&[(Hour, 1.0), (Minute, 2.0)]));
        assert_eq!(parse_duration("weeks"), None);
    }
}
