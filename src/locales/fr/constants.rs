//! upstream `locales/fr/constants.ts`. Ported in full so parser tasks don't edit this file.
//!
//! Dictionaries are `(key, value)` slices **in upstream's key order**. It matters:
//! `match_any_pattern` sorts stably, so equal-length keys keep this order.

use std::sync::LazyLock;

use crate::calculation::duration::{Duration, DurationUnit};
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::js::{js_parse_float, js_parse_int, js_substring_from};
use crate::core::utils::pattern::{
    dict_get, dict_keys, js_len, match_any_pattern, repeated_timeunit_pattern, Dictionary,
};
use crate::js_regex;

pub static WEEKDAY_DICTIONARY: &Dictionary<i64> = &[
    ("dimanche", 0),
    ("dim", 0),
    ("lundi", 1),
    ("lun", 1),
    ("mardi", 2),
    ("mar", 2),
    ("mercredi", 3),
    ("mer", 3),
    ("jeudi", 4),
    ("jeu", 4),
    ("vendredi", 5),
    ("ven", 5),
    ("samedi", 6),
    ("sam", 6),
];

pub static MONTH_DICTIONARY: &Dictionary<i64> = &[
    ("janvier", 1),
    ("jan", 1),
    ("jan.", 1),
    ("janv", 1),
    ("janv.", 1),
    ("février", 2),
    ("fév", 2),
    ("fév.", 2),
    ("févr", 2),
    ("févr.", 2),
    ("fevrier", 2),
    ("fev", 2),
    ("fev.", 2),
    ("fevr", 2),
    ("fevr.", 2),
    ("mars", 3),
    ("mar", 3),
    ("mar.", 3),
    ("avril", 4),
    ("avr", 4),
    ("avr.", 4),
    ("mai", 5),
    ("juin", 6),
    ("juin.", 6),
    ("jun", 6),
    ("jun.", 6),
    ("juillet", 7),
    ("juil", 7),
    ("juil.", 7),
    ("jul", 7),
    ("jul.", 7),
    ("août", 8),
    ("août.", 8),
    ("aout", 8),
    ("aout.", 8),
    ("septembre", 9),
    ("sep", 9),
    ("sep.", 9),
    ("sept", 9),
    ("sept.", 9),
    ("octobre", 10),
    ("oct", 10),
    ("oct.", 10),
    ("novembre", 11),
    ("nov", 11),
    ("nov.", 11),
    ("décembre", 12),
    ("decembre", 12),
    ("dec", 12),
    ("dec.", 12),
    ("déc", 12),
    ("déc.", 12),
];

pub static INTEGER_WORD_DICTIONARY: &Dictionary<i64> = &[
    ("un", 1),
    ("deux", 2),
    ("trois", 3),
    ("quatre", 4),
    ("cinq", 5),
    ("six", 6),
    ("sept", 7),
    ("huit", 8),
    ("neuf", 9),
    ("dix", 10),
    ("onze", 11),
    ("douze", 12),
    ("treize", 13),
];

pub static TIME_UNIT_DICTIONARY: &Dictionary<DurationUnit> = &[
    ("sec", DurationUnit::Second),
    ("seconde", DurationUnit::Second),
    ("secondes", DurationUnit::Second),
    ("min", DurationUnit::Minute),
    ("mins", DurationUnit::Minute),
    ("minute", DurationUnit::Minute),
    ("minutes", DurationUnit::Minute),
    ("h", DurationUnit::Hour),
    ("hr", DurationUnit::Hour),
    ("hrs", DurationUnit::Hour),
    ("heure", DurationUnit::Hour),
    ("heures", DurationUnit::Hour),
    ("jour", DurationUnit::Day),
    ("jours", DurationUnit::Day),
    ("semaine", DurationUnit::Week),
    ("semaines", DurationUnit::Week),
    ("mois", DurationUnit::Month),
    ("trimestre", DurationUnit::Quarter),
    ("trimestres", DurationUnit::Quarter),
    ("ans", DurationUnit::Year),
    ("année", DurationUnit::Year),
    ("années", DurationUnit::Year),
];

//-----------------------------

pub static NUMBER_PATTERN: LazyLock<String> = LazyLock::new(|| {
    format!(
        r"(?:{}|[0-9]+|[0-9]+\.[0-9]+|une?\b|quelques?|demi-?)",
        match_any_pattern(dict_keys(INTEGER_WORD_DICTIONARY))
    )
});

/// `parseNumberPattern(match)`. May be fractional (`demi` = 0.5) or `NaN`.
pub fn parse_number_pattern(m: &str) -> f64 {
    let num = m.to_lowercase();
    if let Some(v) = dict_get(INTEGER_WORD_DICTIONARY, &num) {
        return v as f64;
    }
    if num == "une" || num == "un" {
        return 1.0;
    }
    if js_regex!(r"quelques?").is_match(&num) {
        return 3.0;
    }
    if js_regex!(r"demi-?").is_match(&num) {
        return 0.5;
    }
    js_parse_float(&num)
}

//-----------------------------

pub const ORDINAL_NUMBER_PATTERN: &str = r"(?:[0-9]{1,2}(?:er)?)";

/// `parseOrdinalNumberPattern(match)`. `None` is `NaN`.
pub fn parse_ordinal_number_pattern(m: &str) -> Option<i64> {
    let num = m.to_lowercase();
    let stripped = js_regex!(r"(?:er)$", "i")
        .exec(&num)
        .map_or(num.as_str(), |mm| &num[..mm.index]);
    js_parse_int(stripped)
}

//-----------------------------
// 88 p. Chr. n.
// 234 AC
pub const YEAR_PATTERN: &str = r"(?:[1-9][0-9]{0,3}\s*(?:AC|AD|p\.\s*C(?:hr?)?\.\s*n\.)|[1-2][0-9]{3}|[5-9][0-9])";

/// `match.replace(regex, "")` for a non-global regex: removes the first match only.
fn replace_first(text: &str, m: Option<RegexMatch>) -> String {
    match m {
        Some(m) => format!("{}{}", &text[..m.index], &text[m.index + m.text().len()..]),
        None => text.to_string(),
    }
}

/// `parseYear(match)`. `None` is `NaN`.
pub fn parse_year(m: &str) -> Option<i64> {
    if js_regex!(r"AC", "i").is_match(m) {
        let bc = js_regex!(r"BC", "i");
        return js_parse_int(&replace_first(m, bc.exec(m))).map(|y| -y);
    }

    if js_regex!(r"AD", "i").is_match(m) || js_regex!(r"C", "i").is_match(m) {
        let non_digits = js_regex!(r"[^\d]+", "i");
        return js_parse_int(&replace_first(m, non_digits.exec(m)));
    }

    // `NaN < 100` is false, so NaN passes through unchanged.
    let year_number = js_parse_int(m)?;
    if year_number < 100 {
        if year_number > 50 {
            return Some(year_number + 1900);
        }
        return Some(year_number + 2000);
    }
    Some(year_number)
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
        let number = r"(?:(?:quatre|treize|trois|douze|deux|cinq|sept|huit|neuf|onze|six|dix|un)|[0-9]+|[0-9]+\.[0-9]+|une?\b|quelques?|demi-?)";
        assert_eq!(*NUMBER_PATTERN, number);
        let units = r"(?:(?:trimestres|trimestre|secondes|semaines|seconde|minutes|semaine|minute|heures|années|heure|jours|année|mins|jour|mois|sec|min|hrs|ans|hr|h))";
        let single = format!(r"(?:{number})\s{{0,5}}{units}\s{{0,5}}");
        assert_eq!(
            *TIME_UNITS_PATTERN,
            format!(r"{single}(?:\s{{0,5}},?\s{{0,5}}{single}){{0,10}}")
        );
        for p in [
            &*NUMBER_PATTERN,
            &*TIME_UNITS_PATTERN,
            ORDINAL_NUMBER_PATTERN,
            YEAR_PATTERN,
        ] {
            JsRegex::new(p, "i");
        }
    }

    #[test]
    fn numbers() {
        for (s, v) in [
            ("un", 1.0),
            ("une", 1.0),
            ("Une", 1.0),
            ("treize", 13.0),
            ("quelques", 3.0),
            ("quelque", 3.0),
            ("demi", 0.5),
            ("demi-", 0.5),
            ("2.5", 2.5),
            ("12", 12.0),
            ("sept", 7.0),
        ] {
            assert_eq!(parse_number_pattern(s), v, "{s}");
        }
        assert!(parse_number_pattern("x").is_nan());
        for (s, v) in [
            ("1er", Some(1)),
            ("1ER", Some(1)),
            ("2", Some(2)),
            ("31", Some(31)),
            ("x", None),
        ] {
            assert_eq!(parse_ordinal_number_pattern(s), v, "{s}");
        }
    }

    #[test]
    fn years() {
        for (s, v) in [
            ("2012", Some(2012)),
            ("97", Some(1997)),
            ("12", Some(2012)),
            ("51", Some(1951)),
            ("50", Some(2050)),
            ("234 AC", Some(-234)),
            ("234 ac", Some(-234)),
            ("88 p. Chr. n.", Some(88)),
            ("300 AD", Some(300)),
            ("5 AD", Some(5)),
            ("bc", None),
            ("1900", Some(1900)),
        ] {
            assert_eq!(parse_year(s), v, "{s}");
        }
    }

    #[test]
    fn durations() {
        let d = |pairs: &[(DurationUnit, f64)]| Duration::from_pairs(pairs);
        assert_eq!(parse_duration("5 jours"), d(&[(Day, 5.0)]));
        assert_eq!(parse_duration("2 heures 30 minutes"), d(&[(Hour, 2.0), (Minute, 30.0)]));
        assert_eq!(parse_duration("un mois"), d(&[(Month, 1.0)]));
        assert_eq!(parse_duration("demi heure"), d(&[(Hour, 0.5)]));
        assert_eq!(parse_duration("3h 20min"), d(&[(Hour, 3.0), (Minute, 20.0)]));
        // "an" isn't a unit (only "ans"), so nothing matches.
        assert_eq!(parse_duration("1 an"), Duration::new());
        assert_eq!(parse_duration("jours"), Duration::new());
        assert_eq!(parse_duration("quelques semaines"), d(&[(Week, 3.0)]));
        assert_eq!(parse_duration("1 ans, 2 mois"), d(&[(Year, 1.0), (Month, 2.0)]));
    }
}
