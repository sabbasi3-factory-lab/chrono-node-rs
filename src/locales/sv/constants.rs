//! upstream `locales/sv/constants.ts`. Ported in full so parser tasks don't edit this file.
//!
//! Dictionaries are `(key, value)` slices **in upstream's key order**. It matters:
//! `match_any_pattern` sorts stably, so equal-length keys keep this order.
//!
//! Upstream homoglyphs, kept byte-exact (written as `\u{..}` escapes so they stay visible):
//! `INTEGER_WORD_DICTIONARY` has `"tretti\u{43e}"` (CYRILLIC SMALL LETTER O, so plain Latin
//! "trettio" is *not* a key), and `TIME_UNIT_DICTIONARY` has both `"kvart\u{430}l"` (CYRILLIC
//! SMALL LETTER A) and Latin `"kvartal"`.

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
    ("söndag", 0),
    ("sön", 0),
    ("so", 0),
    ("måndag", 1),
    ("mån", 1),
    ("må", 1),
    ("tisdag", 2),
    ("tis", 2),
    ("ti", 2),
    ("onsdag", 3),
    ("ons", 3),
    ("on", 3),
    ("torsdag", 4),
    ("tors", 4),
    ("to", 4),
    ("fredag", 5),
    ("fre", 5),
    ("fr", 5),
    ("lördag", 6),
    ("lör", 6),
    ("lö", 6),
];

pub static MONTH_DICTIONARY: &Dictionary<i64> = &[
    ("januari", 1),
    ("jan", 1),
    ("jan.", 1),
    ("februari", 2),
    ("feb", 2),
    ("feb.", 2),
    ("mars", 3),
    ("mar", 3),
    ("mar.", 3),
    ("april", 4),
    ("apr", 4),
    ("apr.", 4),
    ("maj", 5),
    ("juni", 6),
    ("jun", 6),
    ("jun.", 6),
    ("juli", 7),
    ("jul", 7),
    ("jul.", 7),
    ("augusti", 8),
    ("aug", 8),
    ("aug.", 8),
    ("september", 9),
    ("sep", 9),
    ("sep.", 9),
    ("sept", 9),
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

pub static ORDINAL_NUMBER_DICTIONARY: &Dictionary<i64> = &[
    ("första", 1),
    ("andra", 2),
    ("tredje", 3),
    ("fjärde", 4),
    ("femte", 5),
    ("sjätte", 6),
    ("sjunde", 7),
    ("åttonde", 8),
    ("nionde", 9),
    ("tionde", 10),
    ("elfte", 11),
    ("tolfte", 12),
    ("trettonde", 13),
    ("fjortonde", 14),
    ("femtonde", 15),
    ("sextonde", 16),
    ("sjuttonde", 17),
    ("artonde", 18),
    ("nittonde", 19),
    ("tjugonde", 20),
    ("tjugoförsta", 21),
    ("tjugoandra", 22),
    ("tjugotredje", 23),
    ("tjugofjärde", 24),
    ("tjugofemte", 25),
    ("tjugosjätte", 26),
    ("tjugosjunde", 27),
    ("tjugoåttonde", 28),
    ("tjugonionde", 29),
    ("trettionde", 30),
    ("trettioförsta", 31),
];

pub static INTEGER_WORD_DICTIONARY: &Dictionary<i64> = &[
    ("en", 1),
    ("ett", 1),
    ("två", 2),
    ("tre", 3),
    ("fyra", 4),
    ("fem", 5),
    ("sex", 6),
    ("sju", 7),
    ("åtta", 8),
    ("nio", 9),
    ("tio", 10),
    ("elva", 11),
    ("tolv", 12),
    ("tretton", 13),
    ("fjorton", 14),
    ("femton", 15),
    ("sexton", 16),
    ("sjutton", 17),
    ("arton", 18),
    ("nitton", 19),
    ("tjugo", 20),
    // Upstream homoglyph: the last letter is CYRILLIC SMALL LETTER O (U+043E).
    ("tretti\u{43e}", 30),
    ("fyrtio", 40),
    ("femtio", 50),
    ("sextio", 60),
    ("sjuttio", 70),
    ("åttio", 80),
    ("nittio", 90),
    ("hundra", 100),
    ("tusen", 1000),
];

pub static TIME_UNIT_DICTIONARY: &Dictionary<DurationUnit> = &[
    ("sek", DurationUnit::Second),
    ("sekund", DurationUnit::Second),
    ("sekunder", DurationUnit::Second),
    ("min", DurationUnit::Minute),
    ("minut", DurationUnit::Minute),
    ("minuter", DurationUnit::Minute),
    ("tim", DurationUnit::Hour),
    ("timme", DurationUnit::Hour),
    ("timmar", DurationUnit::Hour),
    ("dag", DurationUnit::Day),
    ("dagar", DurationUnit::Day),
    ("vecka", DurationUnit::Week),
    ("veckor", DurationUnit::Week),
    ("mån", DurationUnit::Month),
    ("månad", DurationUnit::Month),
    ("månader", DurationUnit::Month),
    ("år", DurationUnit::Year),
    // Upstream homoglyph: the second-to-last letter is CYRILLIC SMALL LETTER A (U+0430).
    ("kvart\u{430}l", DurationUnit::Quarter),
    ("kvartal", DurationUnit::Quarter),
];

pub static TIME_UNIT_NO_ABBR_DICTIONARY: &Dictionary<DurationUnit> = &[
    ("sekund", DurationUnit::Second),
    ("sekunder", DurationUnit::Second),
    ("minut", DurationUnit::Minute),
    ("minuter", DurationUnit::Minute),
    ("timme", DurationUnit::Hour),
    ("timmar", DurationUnit::Hour),
    ("dag", DurationUnit::Day),
    ("dagar", DurationUnit::Day),
    ("vecka", DurationUnit::Week),
    ("veckor", DurationUnit::Week),
    ("månad", DurationUnit::Month),
    ("månader", DurationUnit::Month),
    ("år", DurationUnit::Year),
    ("kvartal", DurationUnit::Quarter),
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

pub static ORDINAL_NUMBER_PATTERN: LazyLock<String> = LazyLock::new(|| {
    format!(
        r"(?:{}|\d{{1,2}}(?:e|:e))",
        match_any_pattern(dict_keys(ORDINAL_NUMBER_DICTIONARY))
    )
});

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

/// `parseNumberPattern(match)`. Upstream falls back to `parseInt`; `None` is `NaN`.
pub fn parse_number_pattern(m: &str) -> Option<i64> {
    let num = m.to_lowercase();
    if let Some(v) = dict_get(INTEGER_WORD_DICTIONARY, &num) {
        return Some(v);
    }
    js_parse_int(&num)
}

/// `parseOrdinalNumberPattern(match)`. `None` is `NaN`.
pub fn parse_ordinal_number_pattern(m: &str) -> Option<i64> {
    let num = m.to_lowercase();
    if let Some(v) = dict_get(ORDINAL_NUMBER_DICTIONARY, &num) {
        return Some(v);
    }
    js_parse_int(&num)
}

/// `parseYear(match)`. `None` is `NaN`.
pub fn parse_year(m: &str) -> Option<i64> {
    if js_regex!(r"\d+").is_match(m) {
        // `NaN < 100` is false, so NaN (e.g. "år 2024") passes through unchanged.
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
    //! Expected values were produced by chrono-node v2.10.3 itself (compiled from `upstream/`).
    use super::*;
    use DurationUnit::*;

    const NUMBER: &str = "(?:(?:tretton|fjorton|sjutton|tretti\u{43e}|sjuttio|femton|sexton|nitton|fyrtio|femtio|sextio|nittio|hundra|arton|tjugo|åttio|tusen|fyra|åtta|elva|tolv|ett|två|tre|fem|sex|sju|nio|tio|en)|\\d+)";

    #[test]
    fn homoglyph_keys_are_byte_exact() {
        let cps = |s: &str| s.chars().map(|c| c as u32).collect::<Vec<_>>();
        let keys: Vec<&str> = dict_keys(INTEGER_WORD_DICTIONARY).collect();
        assert!(keys.contains(&"tretti\u{43e}"));
        assert!(!keys.contains(&"trettio"));
        assert_eq!(cps(keys[21]), [0x74, 0x72, 0x65, 0x74, 0x74, 0x69, 0x43e]);
        let units: Vec<&str> = dict_keys(TIME_UNIT_DICTIONARY).collect();
        assert_eq!(cps(units[17]), [0x6b, 0x76, 0x61, 0x72, 0x74, 0x430, 0x6c]);
        assert_eq!(units[18], "kvartal");
        assert!(units[18].is_ascii());
    }

    #[test]
    fn dictionary_key_order_matches_upstream() {
        let order = |d: &[&str]| d.join(",");
        assert_eq!(
            order(&dict_keys(WEEKDAY_DICTIONARY).collect::<Vec<_>>()),
            "söndag,sön,so,måndag,mån,må,tisdag,tis,ti,onsdag,ons,on,torsdag,tors,to,fredag,fre,fr,lördag,lör,lö"
        );
        assert_eq!(
            order(&dict_keys(MONTH_DICTIONARY).collect::<Vec<_>>()),
            "januari,jan,jan.,februari,feb,feb.,mars,mar,mar.,april,apr,apr.,maj,juni,jun,jun.,juli,jul,jul.,augusti,aug,aug.,september,sep,sep.,sept,oktober,okt,okt.,november,nov,nov.,december,dec,dec."
        );
        assert_eq!(
            order(&dict_keys(TIME_UNIT_NO_ABBR_DICTIONARY).collect::<Vec<_>>()),
            "sekund,sekunder,minut,minuter,timme,timmar,dag,dagar,vecka,veckor,månad,månader,år,kvartal"
        );
    }

    #[test]
    fn patterns_match_upstream_exactly() {
        assert_eq!(*NUMBER_PATTERN, NUMBER);
        assert_eq!(
            *ORDINAL_NUMBER_PATTERN,
            r"(?:(?:trettioförsta|tjugoåttonde|tjugoförsta|tjugotredje|tjugofjärde|tjugosjätte|tjugosjunde|tjugonionde|tjugoandra|tjugofemte|trettionde|trettonde|fjortonde|sjuttonde|femtonde|sextonde|nittonde|tjugonde|åttonde|artonde|första|tredje|fjärde|sjätte|sjunde|nionde|tionde|tolfte|andra|femte|elfte)|\d{1,2}(?:e|:e))"
        );
        let units = "(?:(?:sekunder|minuter|månader|kvart\u{430}l|kvartal|sekund|timmar|veckor|minut|timme|dagar|vecka|månad|sek|min|tim|dag|mån|år))";
        assert_eq!(*TIME_UNIT_PATTERN, units);
        let single = format!(r"(?:{NUMBER})\s{{0,5}}{units}\s{{0,5}}");
        assert_eq!(
            *TIME_UNITS_PATTERN,
            format!(r"{single}(?:\s{{0,5}},?\s{{0,5}}{single}){{0,10}}")
        );
        let units_no_abbr =
            r"(?:(?:sekunder|minuter|månader|kvartal|sekund|timmar|veckor|minut|timme|dagar|vecka|månad|dag|år))";
        let single = format!(r"(?:{NUMBER})\s{{0,5}}{units_no_abbr}\s{{0,5}}");
        assert_eq!(
            *TIME_UNITS_NO_ABBR_PATTERN,
            format!(r"{single}(?:\s{{0,5}},?\s{{0,5}}{single}){{0,10}}")
        );
    }

    #[test]
    fn patterns_match_like_upstream() {
        let first = |p: &str, s: &str| JsRegex::new(p, "i").exec(s).map(|m| m.text().to_string());
        let cases: [(&str, &str, &str); 9] = [
            (&NUMBER_PATTERN, "tjugo", "tjugo"),
            (&NUMBER_PATTERN, "trettio", "tre"),
            (&ORDINAL_NUMBER_PATTERN, "3:e", "3:e"),
            (&ORDINAL_NUMBER_PATTERN, "tjugoförsta", "tjugoförsta"),
            (&TIME_UNIT_PATTERN, "Månader", "Månader"),
            (
                &TIME_UNITS_PATTERN,
                "2 timmar, 30 minuter kvar",
                "2 timmar, 30 minuter ",
            ),
            (&TIME_UNITS_PATTERN, "3 mån 2 dagar", "3 mån 2 dagar"),
            (&TIME_UNITS_NO_ABBR_PATTERN, "3 mån 2 dagar", "2 dagar"),
            (&TIME_UNITS_NO_ABBR_PATTERN, "3 månader 2 dagar", "3 månader 2 dagar"),
        ];
        for (p, s, want) in cases {
            assert_eq!(first(p, s).as_deref(), Some(want), "{s}");
        }
    }

    #[test]
    fn numbers() {
        for (s, v) in [
            ("en", Some(1)),
            ("ett", Some(1)),
            ("Ett", Some(1)),
            ("TVÅ", Some(2)),
            ("ÅTTA", Some(8)),
            ("tjugo", Some(20)),
            ("trettio", None),
            ("tretti\u{43e}", Some(30)),
            ("tusen", Some(1000)),
            ("12", Some(12)),
            ("007", Some(7)),
            ("12abc", Some(12)),
            ("x", None),
            ("", None),
        ] {
            assert_eq!(parse_number_pattern(s), v, "{s}");
        }
        for (s, v) in [
            ("första", Some(1)),
            ("Första", Some(1)),
            ("FJÄRDE", Some(4)),
            ("trettioförsta", Some(31)),
            ("1e", Some(1)),
            ("2:e", Some(2)),
            ("31:e", Some(31)),
            ("12", Some(12)),
            ("x", None),
        ] {
            assert_eq!(parse_ordinal_number_pattern(s), v, "{s}");
        }
    }

    #[test]
    fn years() {
        for (s, v) in [
            ("2024", Some(2024)),
            ("1999", Some(1999)),
            ("97", Some(1997)),
            ("12", Some(2012)),
            ("51", Some(1951)),
            ("50", Some(2050)),
            ("5", Some(2005)),
            ("0", Some(2000)),
            ("år 2024", None),
            ("2024 e.Kr.", Some(2024)),
            ("12abc", Some(2012)),
            ("99999", Some(99999)),
            ("tjugo", Some(20)),
            ("Tusen", Some(1000)),
            ("hundra", Some(100)),
            ("x", None),
            ("", None),
        ] {
            assert_eq!(parse_year(s), v, "{s}");
        }
    }

    #[test]
    fn durations() {
        let d = |pairs: &[(DurationUnit, f64)]| Duration::from_pairs(pairs);
        for (s, want) in [
            ("5 dagar", d(&[(Day, 5.0)])),
            ("2 timmar 30 minuter", d(&[(Hour, 2.0), (Minute, 30.0)])),
            ("en månad", d(&[(Month, 1.0)])),
            ("ett år", d(&[(Year, 1.0)])),
            ("3 veckor, 2 dagar", d(&[(Week, 3.0), (Day, 2.0)])),
            ("1 sek", d(&[(Second, 1.0)])),
            ("10 min", d(&[(Minute, 10.0)])),
            ("tre mån", d(&[(Month, 3.0)])),
            ("2 kvartal", d(&[(Quarter, 2.0)])),
            ("2 kvart\u{430}l", d(&[(Quarter, 2.0)])),
            ("2 KVART\u{410}L", d(&[(Quarter, 2.0)])),
            ("DAGAR", Duration::new()),
            ("5 DAGAR", d(&[(Day, 5.0)])),
            ("2 ÅR", d(&[(Year, 2.0)])),
            ("1 MÅN", d(&[(Month, 1.0)])),
            ("två timmar och 5 minuter", d(&[(Hour, 2.0), (Minute, 5.0)])),
            ("x 3 dagar", d(&[(Day, 3.0)])),
            ("abcdefgh 3 dagar 4 timmar", d(&[(Day, 3.0), (Hour, 4.0)])),
            ("1 dag 2 dag", d(&[(Day, 2.0)])),
            ("trettio dagar", d(&[(Day, 10.0)])),
            ("tretti\u{43e} dagar", d(&[(Day, 30.0)])),
            ("45minuter", d(&[(Minute, 45.0)])),
            ("1timme", d(&[(Hour, 1.0)])),
        ] {
            assert_eq!(parse_duration(s), want, "{s}");
        }
    }
}
