//! upstream `locales/it/constants.ts`. Ported in full so parser tasks don't edit this file.
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

pub static WEEKDAY_DICTIONARY: &Dictionary<i64> = &[
    ("domenica", 0),
    ("dom", 0),
    ("dom.", 0),
    ("lunedì", 1),
    ("lunedi", 1),
    ("lun", 1),
    ("lun.", 1),
    ("martedì", 2),
    ("martedi", 2),
    ("mar", 2),
    ("mar.", 2),
    ("mercoledì", 3),
    ("mercoledi", 3),
    ("mer", 3),
    ("mer.", 3),
    ("giovedì", 4),
    ("giovedi", 4),
    ("gio", 4),
    ("gio.", 4),
    ("venerdì", 5),
    ("venerdi", 5),
    ("ven", 5),
    ("ven.", 5),
    ("sabato", 6),
    ("sab", 6),
    ("sab.", 6),
];

pub static FULL_MONTH_NAME_DICTIONARY: &Dictionary<i64> = &[
    ("gennaio", 1),
    ("febbraio", 2),
    ("marzo", 3),
    ("aprile", 4),
    ("maggio", 5),
    ("giugno", 6),
    ("luglio", 7),
    ("agosto", 8),
    ("settembre", 9),
    ("ottobre", 10),
    ("novembre", 11),
    ("dicembre", 12),
];

pub static MONTH_DICTIONARY: &Dictionary<i64> = &[
    ("gennaio", 1),
    ("febbraio", 2),
    ("marzo", 3),
    ("aprile", 4),
    ("maggio", 5),
    ("giugno", 6),
    ("luglio", 7),
    ("agosto", 8),
    ("settembre", 9),
    ("ottobre", 10),
    ("novembre", 11),
    ("dicembre", 12),
    ("gen", 1),
    ("gen.", 1),
    ("feb", 2),
    ("feb.", 2),
    ("mar", 3),
    ("mar.", 3),
    ("apr", 4),
    ("apr.", 4),
    ("mag", 5),
    ("mag.", 5),
    ("giu", 6),
    ("giu.", 6),
    ("lug", 7),
    ("lug.", 7),
    ("ago", 8),
    ("ago.", 8),
    ("set", 9),
    ("set.", 9),
    ("sett", 9),
    ("sett.", 9),
    ("ott", 10),
    ("ott.", 10),
    ("nov", 11),
    ("nov.", 11),
    ("dic", 12),
    ("dic.", 12),
];

pub static INTEGER_WORD_DICTIONARY: &Dictionary<i64> = &[
    ("uno", 1),
    ("una", 1),
    ("un", 1),
    ("due", 2),
    ("tre", 3),
    ("quattro", 4),
    ("cinque", 5),
    ("sei", 6),
    ("sette", 7),
    ("otto", 8),
    ("nove", 9),
    ("dieci", 10),
    ("undici", 11),
    ("dodici", 12),
];

pub static ORDINAL_WORD_DICTIONARY: &Dictionary<i64> = &[
    ("primo", 1),
    ("prima", 1),
    ("1°", 1),
    ("1ª", 1),
    ("secondo", 2),
    ("seconda", 2),
    ("2°", 2),
    ("2ª", 2),
    ("terzo", 3),
    ("terza", 3),
    ("3°", 3),
    ("3ª", 3),
    ("quarto", 4),
    ("quarta", 4),
    ("4°", 4),
    ("4ª", 4),
    ("quinto", 5),
    ("quinta", 5),
    ("5°", 5),
    ("5ª", 5),
    ("sesto", 6),
    ("sesta", 6),
    ("6°", 6),
    ("6ª", 6),
    ("settimo", 7),
    ("settima", 7),
    ("7°", 7),
    ("7ª", 7),
    ("ottavo", 8),
    ("ottava", 8),
    ("8°", 8),
    ("8ª", 8),
    ("nono", 9),
    ("nona", 9),
    ("9°", 9),
    ("9ª", 9),
    ("decimo", 10),
    ("decima", 10),
    ("10°", 10),
    ("10ª", 10),
    ("undicesimo", 11),
    ("undicesima", 11),
    ("11°", 11),
    ("11ª", 11),
    ("dodicesimo", 12),
    ("dodicesima", 12),
    ("12°", 12),
    ("12ª", 12),
    ("tredicesimo", 13),
    ("tredicesima", 13),
    ("13°", 13),
    ("13ª", 13),
    ("quattordicesimo", 14),
    ("quattordicesima", 14),
    ("14°", 14),
    ("14ª", 14),
    ("quindicesimo", 15),
    ("quindicesima", 15),
    ("15°", 15),
    ("15ª", 15),
    ("sedicesimo", 16),
    ("sedicesima", 16),
    ("16°", 16),
    ("16ª", 16),
    ("diciassettesimo", 17),
    ("diciassettesima", 17),
    ("17°", 17),
    ("17ª", 17),
    ("diciottesimo", 18),
    ("diciottesima", 18),
    ("18°", 18),
    ("18ª", 18),
    ("diciannovesimo", 19),
    ("diciannovesima", 19),
    ("19°", 19),
    ("19ª", 19),
    ("ventesimo", 20),
    ("ventesima", 20),
    ("20°", 20),
    ("20ª", 20),
    ("ventunesimo", 21),
    ("ventunesima", 21),
    ("21°", 21),
    ("21ª", 21),
    ("ventiduesimo", 22),
    ("ventiduesima", 22),
    ("22°", 22),
    ("22ª", 22),
    ("ventitreesimo", 23),
    ("ventitreesima", 23),
    ("23°", 23),
    ("23ª", 23),
    ("ventiquattresimo", 24),
    ("ventiquattresima", 24),
    ("24°", 24),
    ("24ª", 24),
    ("venticinquesimo", 25),
    ("venticinquesima", 25),
    ("25°", 25),
    ("25ª", 25),
    ("ventiseiesimo", 26),
    ("ventiseiesima", 26),
    ("26°", 26),
    ("26ª", 26),
    ("ventisettesimo", 27),
    ("ventisettesima", 27),
    ("27°", 27),
    ("27ª", 27),
    ("ventottesimo", 28),
    ("ventottesima", 28),
    ("28°", 28),
    ("28ª", 28),
    ("ventinovesimo", 29),
    ("ventinovesima", 29),
    ("29°", 29),
    ("29ª", 29),
    ("trentesimo", 30),
    ("trentesima", 30),
    ("30°", 30),
    ("30ª", 30),
    ("trentunesimo", 31),
    ("trentunesima", 31),
    ("31°", 31),
    ("31ª", 31),
];

pub static TIME_UNIT_DICTIONARY_NO_ABBR: &Dictionary<DurationUnit> = &[
    ("secondo", DurationUnit::Second),
    ("secondi", DurationUnit::Second),
    ("minuto", DurationUnit::Minute),
    ("minuti", DurationUnit::Minute),
    ("ora", DurationUnit::Hour),
    ("ore", DurationUnit::Hour),
    ("giorno", DurationUnit::Day),
    ("giorni", DurationUnit::Day),
    ("settimana", DurationUnit::Week),
    ("settimane", DurationUnit::Week),
    ("mese", DurationUnit::Month),
    ("mesi", DurationUnit::Month),
    ("trimestre", DurationUnit::Quarter),
    ("trimestri", DurationUnit::Quarter),
    ("anno", DurationUnit::Year),
    ("anni", DurationUnit::Year),
];

// The spread `...TIME_UNIT_DICTIONARY_NO_ABBR` repeats keys already defined above; in a JS object
// literal a repeated key keeps its first position, so no entry is added.
pub static TIME_UNIT_DICTIONARY: &Dictionary<DurationUnit> = &[
    ("s", DurationUnit::Second),
    ("sec", DurationUnit::Second),
    ("secondo", DurationUnit::Second),
    ("secondi", DurationUnit::Second),
    ("m", DurationUnit::Minute),
    ("min", DurationUnit::Minute),
    ("minuto", DurationUnit::Minute),
    ("minuti", DurationUnit::Minute),
    ("h", DurationUnit::Hour),
    ("ora", DurationUnit::Hour),
    ("ore", DurationUnit::Hour),
    ("g", DurationUnit::Day),
    ("gg", DurationUnit::Day),
    ("giorno", DurationUnit::Day),
    ("giorni", DurationUnit::Day),
    ("sett", DurationUnit::Week),
    ("settimana", DurationUnit::Week),
    ("settimane", DurationUnit::Week),
    ("mese", DurationUnit::Month),
    ("mesi", DurationUnit::Month),
    ("trim", DurationUnit::Quarter),
    ("trimestre", DurationUnit::Quarter),
    ("trimestri", DurationUnit::Quarter),
    ("anno", DurationUnit::Year),
    ("anni", DurationUnit::Year),
];

//-----------------------------

pub static NUMBER_PATTERN: LazyLock<String> = LazyLock::new(|| {
    format!(
        r"(?:{}|[0-9]+|[0-9]+\.[0-9]+|mezz[oa]?(?:\s{{0,2}})?|un(?:'|\s{{0,2}})?|qualche|alcuni|paio\s{{0,2}}(?:di)?)",
        match_any_pattern(dict_keys(INTEGER_WORD_DICTIONARY))
    )
});

/// `parseNumberPattern(match)`. May be fractional (`mezzo` = 0.5); `None` is `NaN`.
pub fn parse_number_pattern(m: &str) -> Option<f64> {
    let num = m.to_lowercase();
    if let Some(v) = dict_get(INTEGER_WORD_DICTIONARY, &num) {
        return Some(v as f64);
    } else if num == "un" || num == "un'" || num == "una" || num == "uno" {
        return Some(1.0);
    } else if js_regex!(r"qualche").is_match(&num) {
        return Some(3.0);
    } else if js_regex!(r"mezz").is_match(&num) {
        return Some(0.5);
    } else if js_regex!(r"paio").is_match(&num) {
        return Some(2.0);
    } else if js_regex!(r"alcuni").is_match(&num) {
        return Some(7.0);
    }

    let n = js_parse_float(&num);
    (!n.is_nan()).then_some(n)
}

//-----------------------------

pub static ORDINAL_NUMBER_PATTERN: LazyLock<String> = LazyLock::new(|| {
    format!(
        r"(?:{}|[0-9]{{1,2}}(?:°|ª|º)?)",
        match_any_pattern(dict_keys(ORDINAL_WORD_DICTIONARY))
    )
});

/// `parseOrdinalNumberPattern(match)`. `None` is `NaN`.
pub fn parse_ordinal_number_pattern(m: &str) -> Option<i64> {
    let num = m.to_lowercase();
    if let Some(v) = dict_get(ORDINAL_WORD_DICTIONARY, &num) {
        return Some(v);
    }

    js_parse_int(&replace_first(js_regex!(r"(?:°|ª|º)$", "i"), &num))
}

//-----------------------------

pub const YEAR_PATTERN: &str = r"(?:[1-9][0-9]{0,3}\s{0,2}(?:BE|AD|BC|BCE|CE)|[1-2][0-9]{3}|[5-9][0-9]|2[0-5])";

/// `parseYear(match)`. `None` is `NaN`.
pub fn parse_year(m: &str) -> Option<i64> {
    let be = js_regex!(r"BE", "i");
    if be.is_match(m) {
        // Buddhist Era
        return js_parse_int(&replace_first(be, m)).map(|y| y - 543);
    }

    let bce = js_regex!(r"BCE?", "i");
    if bce.is_match(m) {
        // Before Christ, Before Common Era
        return js_parse_int(&replace_first(bce, m)).map(|y| -y);
    }

    let ad = js_regex!(r"(AD|CE)", "i");
    if ad.is_match(m) {
        // Anno Domini, Common Era
        return js_parse_int(&replace_first(ad, m));
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
        r"({})\s{{0,3}}({})",
        *NUMBER_PATTERN,
        match_any_pattern(dict_keys(TIME_UNIT_DICTIONARY))
    )
});

static SINGLE_TIME_UNIT_REGEX: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new(&SINGLE_TIME_UNIT_PATTERN, "i"));

static SINGLE_TIME_UNIT_NO_ABBR_PATTERN: LazyLock<String> = LazyLock::new(|| {
    format!(
        r"({})\s{{0,3}}({})",
        *NUMBER_PATTERN,
        match_any_pattern(dict_keys(TIME_UNIT_DICTIONARY_NO_ABBR))
    )
});

const TIME_UNIT_CONNECTOR_PATTERN: &str = r"\s{0,5},?(?:\s*e)?\s{0,5}";

pub static TIME_UNITS_PATTERN: LazyLock<String> = LazyLock::new(|| {
    repeated_timeunit_pattern(
        r"(?:(?:circa|approssimativamente)\s{0,3})?",
        &SINGLE_TIME_UNIT_PATTERN,
        Some(TIME_UNIT_CONNECTOR_PATTERN),
    )
});

pub static TIME_UNITS_NO_ABBR_PATTERN: LazyLock<String> = LazyLock::new(|| {
    repeated_timeunit_pattern(
        r"(?:(?:circa|approssimativamente)\s{0,3})?",
        &SINGLE_TIME_UNIT_NO_ABBR_PATTERN,
        Some(TIME_UNIT_CONNECTOR_PATTERN),
    )
});

/// `parseDuration(timeunitText)`: `None` is upstream's `null` (no fragment found).
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

fn collect_date_time_fragment(fragments: &mut Duration, m: &RegexMatch) {
    if js_regex!(r"^[a-zA-Z]+$").is_match(m.text()) {
        return;
    }
    let num = parse_number_pattern(m.get(1).unwrap_or("")).unwrap_or(f64::NAN);
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
            ("domenica", 0),
            ("dom", 0),
            ("dom.", 0),
            ("lunedì", 1),
            ("lunedi", 1),
            ("lun", 1),
            ("lun.", 1),
            ("martedì", 2),
            ("martedi", 2),
            ("mar", 2),
            ("mar.", 2),
            ("mercoledì", 3),
            ("mercoledi", 3),
            ("mer", 3),
            ("mer.", 3),
            ("giovedì", 4),
            ("giovedi", 4),
            ("gio", 4),
            ("gio.", 4),
            ("venerdì", 5),
            ("venerdi", 5),
            ("ven", 5),
            ("ven.", 5),
            ("sabato", 6),
            ("sab", 6),
            ("sab.", 6),
        ];
        entries(WEEKDAY_DICTIONARY, &words);
    }

    #[test]
    fn full_month_name_dictionary_matches_upstream() {
        let words = [
            ("gennaio", 1),
            ("febbraio", 2),
            ("marzo", 3),
            ("aprile", 4),
            ("maggio", 5),
            ("giugno", 6),
            ("luglio", 7),
            ("agosto", 8),
            ("settembre", 9),
            ("ottobre", 10),
            ("novembre", 11),
            ("dicembre", 12),
        ];
        entries(FULL_MONTH_NAME_DICTIONARY, &words);
    }

    #[test]
    fn month_dictionary_matches_upstream() {
        let words = [
            ("gennaio", 1),
            ("febbraio", 2),
            ("marzo", 3),
            ("aprile", 4),
            ("maggio", 5),
            ("giugno", 6),
            ("luglio", 7),
            ("agosto", 8),
            ("settembre", 9),
            ("ottobre", 10),
            ("novembre", 11),
            ("dicembre", 12),
            ("gen", 1),
            ("gen.", 1),
            ("feb", 2),
            ("feb.", 2),
            ("mar", 3),
            ("mar.", 3),
            ("apr", 4),
            ("apr.", 4),
            ("mag", 5),
            ("mag.", 5),
            ("giu", 6),
            ("giu.", 6),
            ("lug", 7),
            ("lug.", 7),
            ("ago", 8),
            ("ago.", 8),
            ("set", 9),
            ("set.", 9),
            ("sett", 9),
            ("sett.", 9),
            ("ott", 10),
            ("ott.", 10),
            ("nov", 11),
            ("nov.", 11),
            ("dic", 12),
            ("dic.", 12),
        ];
        entries(MONTH_DICTIONARY, &words);
    }

    #[test]
    fn integer_word_dictionary_matches_upstream() {
        let words = [
            ("uno", 1),
            ("una", 1),
            ("un", 1),
            ("due", 2),
            ("tre", 3),
            ("quattro", 4),
            ("cinque", 5),
            ("sei", 6),
            ("sette", 7),
            ("otto", 8),
            ("nove", 9),
            ("dieci", 10),
            ("undici", 11),
            ("dodici", 12),
        ];
        entries(INTEGER_WORD_DICTIONARY, &words);
    }

    #[test]
    fn ordinal_word_dictionary_matches_upstream() {
        // (masculine, feminine) for 1..=31; each number also has "n°" and "nª".
        let stems = [
            ("primo", "prima"),
            ("secondo", "seconda"),
            ("terzo", "terza"),
            ("quarto", "quarta"),
            ("quinto", "quinta"),
            ("sesto", "sesta"),
            ("settimo", "settima"),
            ("ottavo", "ottava"),
            ("nono", "nona"),
            ("decimo", "decima"),
            ("undicesimo", "undicesima"),
            ("dodicesimo", "dodicesima"),
            ("tredicesimo", "tredicesima"),
            ("quattordicesimo", "quattordicesima"),
            ("quindicesimo", "quindicesima"),
            ("sedicesimo", "sedicesima"),
            ("diciassettesimo", "diciassettesima"),
            ("diciottesimo", "diciottesima"),
            ("diciannovesimo", "diciannovesima"),
            ("ventesimo", "ventesima"),
            ("ventunesimo", "ventunesima"),
            ("ventiduesimo", "ventiduesima"),
            ("ventitreesimo", "ventitreesima"),
            ("ventiquattresimo", "ventiquattresima"),
            ("venticinquesimo", "venticinquesima"),
            ("ventiseiesimo", "ventiseiesima"),
            ("ventisettesimo", "ventisettesima"),
            ("ventottesimo", "ventottesima"),
            ("ventinovesimo", "ventinovesima"),
            ("trentesimo", "trentesima"),
            ("trentunesimo", "trentunesima"),
        ];
        let mut expected: Vec<(String, i64)> = Vec::new();
        for (i, (m, f)) in stems.iter().enumerate() {
            let n = i as i64 + 1;
            expected.extend([(m.to_string(), n), (f.to_string(), n), (format!("{n}°"), n), (format!("{n}ª"), n)]);
        }
        assert_eq!(ORDINAL_WORD_DICTIONARY.len(), expected.len());
        for (i, (k, v)) in expected.iter().enumerate() {
            assert_eq!(ORDINAL_WORD_DICTIONARY[i], (k.as_str(), *v), "{k}");
        }
    }

    #[test]
    fn time_unit_dictionary_no_abbr_matches_upstream() {
        let words = [
            ("secondo", Second),
            ("secondi", Second),
            ("minuto", Minute),
            ("minuti", Minute),
            ("ora", Hour),
            ("ore", Hour),
            ("giorno", Day),
            ("giorni", Day),
            ("settimana", Week),
            ("settimane", Week),
            ("mese", Month),
            ("mesi", Month),
            ("trimestre", Quarter),
            ("trimestri", Quarter),
            ("anno", Year),
            ("anni", Year),
        ];
        entries(TIME_UNIT_DICTIONARY_NO_ABBR, &words);
    }

    #[test]
    fn time_unit_dictionary_matches_upstream() {
        let words = [
            ("s", Second),
            ("sec", Second),
            ("secondo", Second),
            ("secondi", Second),
            ("m", Minute),
            ("min", Minute),
            ("minuto", Minute),
            ("minuti", Minute),
            ("h", Hour),
            ("ora", Hour),
            ("ore", Hour),
            ("g", Day),
            ("gg", Day),
            ("giorno", Day),
            ("giorni", Day),
            ("sett", Week),
            ("settimana", Week),
            ("settimane", Week),
            ("mese", Month),
            ("mesi", Month),
            ("trim", Quarter),
            ("trimestre", Quarter),
            ("trimestri", Quarter),
            ("anno", Year),
            ("anni", Year),
        ];
        entries(TIME_UNIT_DICTIONARY, &words);
    }

    #[test]
    fn number_pattern_matches_upstream() {
        assert_eq!(
            *NUMBER_PATTERN,
            r"(?:(?:quattro|cinque|undici|dodici|sette|dieci|otto|nove|uno|una|due|tre|sei|un)|[0-9]+|[0-9]+\.[0-9]+|mezz[oa]?(?:\s{0,2})?|un(?:'|\s{0,2})?|qualche|alcuni|paio\s{0,2}(?:di)?)"
        );
    }

    fn num(s: &str, expect: Option<f64>) {
        assert_eq!(parse_number_pattern(s), expect, "{s}");
    }

    #[test]
    fn parse_number_pattern_case_1() {
        num("0", Some(0.0));
    }
    #[test]
    fn parse_number_pattern_case_2() {
        num("g", None);
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
        num("1ª", Some(1.0));
    }
    #[test]
    fn parse_number_pattern_case_6() {
        num("2ª", Some(2.0));
    }
    #[test]
    fn parse_number_pattern_case_7() {
        num("3ª", Some(3.0));
    }
    #[test]
    fn parse_number_pattern_case_8() {
        num("un", Some(1.0));
    }

    #[test]
    fn ordinal_number_pattern_matches_upstream() {
        assert_eq!(
            *ORDINAL_NUMBER_PATTERN,
            "(?:(?:ventiquattresimo|ventiquattresima|quattordicesimo|quattordicesima|diciassettesimo|diciassettesima|venticinquesimo|venticinquesima|diciannovesimo|diciannovesima|ventisettesimo|ventisettesima|ventitreesimo|ventitreesima|ventiseiesimo|ventiseiesima|ventinovesimo|ventinovesima|quindicesimo|quindicesima|diciottesimo|diciottesima|ventiduesimo|ventiduesima|ventottesimo|ventottesima|trentunesimo|trentunesima|tredicesimo|tredicesima|ventunesimo|ventunesima|undicesimo|undicesima|dodicesimo|dodicesima|sedicesimo|sedicesima|trentesimo|trentesima|ventesimo|ventesima|secondo|seconda|settimo|settima|quarto|quarta|quinto|quinta|ottavo|ottava|decimo|decima|primo|prima|terzo|terza|sesto|sesta|nono|nona|10°|10ª|11°|11ª|12°|12ª|13°|13ª|14°|14ª|15°|15ª|16°|16ª|17°|17ª|18°|18ª|19°|19ª|20°|20ª|21°|21ª|22°|22ª|23°|23ª|24°|24ª|25°|25ª|26°|26ª|27°|27ª|28°|28ª|29°|29ª|30°|30ª|31°|31ª|1°|1ª|2°|2ª|3°|3ª|4°|4ª|5°|5ª|6°|6ª|7°|7ª|8°|8ª|9°|9ª)|[0-9]{1,2}(?:°|ª|º)?)"
        );
    }

    fn ord(s: &str, expect: Option<i64>) {
        assert_eq!(parse_ordinal_number_pattern(s), expect, "{s}");
    }

    #[test]
    fn parse_ordinal_number_pattern_case_1() {
        ord("0", Some(0));
    }
    #[test]
    fn parse_ordinal_number_pattern_case_2() {
        ord("g", None);
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
        ord("1ª", Some(1));
    }
    #[test]
    fn parse_ordinal_number_pattern_case_6() {
        ord("2ª", Some(2));
    }
    #[test]
    fn parse_ordinal_number_pattern_case_7() {
        ord("3ª", Some(3));
    }
    #[test]
    fn parse_ordinal_number_pattern_case_8() {
        ord("nono", Some(9));
    }

    #[test]
    fn year_pattern_matches_upstream() {
        assert_eq!(
            YEAR_PATTERN,
            r"(?:[1-9][0-9]{0,3}\s{0,2}(?:BE|AD|BC|BCE|CE)|[1-2][0-9]{3}|[5-9][0-9]|2[0-5])"
        );
    }

    fn year(s: &str, expect: Option<i64>) {
        assert_eq!(parse_year(s), expect, "{s}");
    }

    #[test]
    fn parse_year_case_1() {
        year("0", Some(2000));
    }
    #[test]
    fn parse_year_case_2() {
        year("g", None);
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
        year("1ª", Some(2001));
    }
    #[test]
    fn parse_year_case_6() {
        year("2ª", Some(2002));
    }
    #[test]
    fn parse_year_case_7() {
        year("3ª", Some(2003));
    }

    const NUMBER: &str = r"(?:(?:quattro|cinque|undici|dodici|sette|dieci|otto|nove|uno|una|due|tre|sei|un)|[0-9]+|[0-9]+\.[0-9]+|mezz[oa]?(?:\s{0,2})?|un(?:'|\s{0,2})?|qualche|alcuni|paio\s{0,2}(?:di)?)";

    #[test]
    fn time_units_pattern_matches_upstream() {
        let units = r"(?:(?:settimana|settimane|trimestre|trimestri|secondo|secondi|minuto|minuti|giorno|giorni|sett|mese|mesi|trim|anno|anni|sec|min|ora|ore|gg|s|m|h|g))";
        let single = format!(r"(?:{NUMBER})\s{{0,3}}{units}");
        assert_eq!(
            *TIME_UNITS_PATTERN,
            format!(
                r"(?:(?:circa|approssimativamente)\s{{0,3}})?{single}(?:\s{{0,5}},?(?:\s*e)?\s{{0,5}}{single}){{0,10}}"
            )
        );
    }

    #[test]
    fn time_units_no_abbr_pattern_matches_upstream() {
        let units = r"(?:(?:settimana|settimane|trimestre|trimestri|secondo|secondi|minuto|minuti|giorno|giorni|mese|mesi|anno|anni|ora|ore))";
        let single = format!(r"(?:{NUMBER})\s{{0,3}}{units}");
        assert_eq!(
            *TIME_UNITS_NO_ABBR_PATTERN,
            format!(
                r"(?:(?:circa|approssimativamente)\s{{0,3}})?{single}(?:\s{{0,5}},?(?:\s*e)?\s{{0,5}}{single}){{0,10}}"
            )
        );
    }

    fn dur(s: &str, expect: Option<Duration>) {
        assert_eq!(parse_duration(s), expect, "{s}");
    }

    #[test]
    fn parse_duration_case_1() {
        dur("0", None);
    }
    #[test]
    fn parse_duration_case_2() {
        dur("0 m", Some(Duration::from_pairs(&[(Minute, 0.0)])));
    }
    #[test]
    fn parse_duration_case_3() {
        dur("5 m", Some(Duration::from_pairs(&[(Minute, 5.0)])));
    }
    #[test]
    fn parse_duration_case_4() {
        dur("10 g", Some(Duration::from_pairs(&[(Day, 10.0)])));
    }
    #[test]
    fn parse_duration_case_5() {
        dur("un giorno", Some(Duration::from_pairs(&[(Day, 1.0)])));
    }
    #[test]
    fn parse_duration_case_6() {
        dur("una settimana", Some(Duration::from_pairs(&[(Week, 1.0)])));
    }
}
