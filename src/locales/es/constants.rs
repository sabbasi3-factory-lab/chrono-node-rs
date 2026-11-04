//! upstream `locales/es/constants.ts`. Ported in full so parser tasks don't edit this file.
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
    ("domingo", 0),
    ("dom", 0),
    ("lunes", 1),
    ("lun", 1),
    ("martes", 2),
    ("mar", 2),
    ("miércoles", 3),
    ("miercoles", 3),
    ("mié", 3),
    ("mie", 3),
    ("jueves", 4),
    ("jue", 4),
    ("viernes", 5),
    ("vie", 5),
    ("sábado", 6),
    ("sabado", 6),
    ("sáb", 6),
    ("sab", 6),
];

pub static FULL_MONTH_NAME_DICTIONARY: &Dictionary<i64> = &[
    ("enero", 1),
    ("febrero", 2),
    ("marzo", 3),
    ("abril", 4),
    ("mayo", 5),
    ("junio", 6),
    ("julio", 7),
    ("agosto", 8),
    ("septiembre", 9),
    ("setiembre", 9),
    ("octubre", 10),
    ("noviembre", 11),
    ("diciembre", 12),
];

/// `{ ...FULL_MONTH_NAME_DICTIONARY, ene: 1, ... }`.
pub static MONTH_DICTIONARY: &Dictionary<i64> = &[
    ("enero", 1),
    ("febrero", 2),
    ("marzo", 3),
    ("abril", 4),
    ("mayo", 5),
    ("junio", 6),
    ("julio", 7),
    ("agosto", 8),
    ("septiembre", 9),
    ("setiembre", 9),
    ("octubre", 10),
    ("noviembre", 11),
    ("diciembre", 12),
    ("ene", 1),
    ("ene.", 1),
    ("feb", 2),
    ("feb.", 2),
    ("mar", 3),
    ("mar.", 3),
    ("abr", 4),
    ("abr.", 4),
    ("may", 5),
    ("may.", 5),
    ("jun", 6),
    ("jun.", 6),
    ("jul", 7),
    ("jul.", 7),
    ("ago", 8),
    ("ago.", 8),
    ("sep", 9),
    ("sep.", 9),
    ("oct", 10),
    ("oct.", 10),
    ("nov", 11),
    ("nov.", 11),
    ("dic", 12),
    ("dic.", 12),
];

pub static INTEGER_WORD_DICTIONARY: &Dictionary<i64> = &[
    ("uno", 1),
    ("dos", 2),
    ("tres", 3),
    ("cuatro", 4),
    ("cinco", 5),
    ("seis", 6),
    ("siete", 7),
    ("ocho", 8),
    ("nueve", 9),
    ("diez", 10),
    ("once", 11),
    ("doce", 12),
    ("trece", 13),
];

pub static ORDINAL_WORD_DICTIONARY: &Dictionary<i64> = &[
    ("primero", 1),
    ("primera", 1),
    ("segundo", 2),
    ("segunda", 2),
    ("tercero", 3),
    ("tercera", 3),
    ("cuarto", 4),
    ("cuarta", 4),
    ("quinto", 5),
    ("quinta", 5),
    ("sexto", 6),
    ("sexta", 6),
    ("séptimo", 7),
    ("septimo", 7),
    ("séptima", 7),
    ("septima", 7),
    ("octavo", 8),
    ("octava", 8),
    ("noveno", 9),
    ("novena", 9),
    ("décimo", 10),
    ("decimo", 10),
    ("décima", 10),
    ("decima", 10),
    ("undécimo", 11),
    ("undecimo", 11),
    ("duodécimo", 12),
    ("duodecimo", 12),
    ("decimotercero", 13),
    ("decimocuarto", 14),
    ("decimoquinto", 15),
    ("decimosexto", 16),
    ("decimoséptimo", 17),
    ("decimoseptimo", 17),
    ("decimoctavo", 18),
    ("decimonoveno", 19),
    ("vigésimo", 20),
    ("vigesimo", 20),
    ("vigésimo primero", 21),
    ("vigesimo primero", 21),
    ("vigésimo segundo", 22),
    ("vigesimo segundo", 22),
    ("vigésimo tercero", 23),
    ("vigesimo tercero", 23),
    ("vigésimo cuarto", 24),
    ("vigesimo cuarto", 24),
    ("vigésimo quinto", 25),
    ("vigesimo quinto", 25),
    ("vigésimo sexto", 26),
    ("vigesimo sexto", 26),
    ("vigésimo séptimo", 27),
    ("vigesimo septimo", 27),
    ("vigésimo octavo", 28),
    ("vigesimo octavo", 28),
    ("vigésimo noveno", 29),
    ("vigesimo noveno", 29),
    ("trigésimo", 30),
    ("trigesimo", 30),
    ("trigésimo primero", 31),
    ("trigesimo primero", 31),
];

pub static TIME_UNIT_DICTIONARY: &Dictionary<DurationUnit> = &[
    ("sec", DurationUnit::Second),
    ("segundo", DurationUnit::Second),
    ("segundos", DurationUnit::Second),
    ("min", DurationUnit::Minute),
    ("mins", DurationUnit::Minute),
    ("minuto", DurationUnit::Minute),
    ("minutos", DurationUnit::Minute),
    ("h", DurationUnit::Hour),
    ("hr", DurationUnit::Hour),
    ("hrs", DurationUnit::Hour),
    ("hora", DurationUnit::Hour),
    ("horas", DurationUnit::Hour),
    ("día", DurationUnit::Day),
    ("días", DurationUnit::Day),
    ("dia", DurationUnit::Day),
    ("dias", DurationUnit::Day),
    ("semana", DurationUnit::Week),
    ("semanas", DurationUnit::Week),
    ("mes", DurationUnit::Month),
    ("meses", DurationUnit::Month),
    ("cuarto", DurationUnit::Quarter),
    ("cuartos", DurationUnit::Quarter),
    ("año", DurationUnit::Year),
    ("años", DurationUnit::Year),
    ("ano", DurationUnit::Year),
    ("anos", DurationUnit::Year),
];

//-----------------------------

pub static NUMBER_PATTERN: LazyLock<String> = LazyLock::new(|| {
    format!(
        r"(?:{}|[0-9]+|[0-9]+\.[0-9]+|un?|uno?|una?|algunos?|unos?|demi-?)",
        match_any_pattern(dict_keys(INTEGER_WORD_DICTIONARY))
    )
});

/// `parseNumberPattern(match)`. May be fractional (`media` = 0.5) or `NaN`.
///
/// Upstream quirk: `NUMBER_PATTERN` accepts `demi`, but only `media?` maps to 0.5, so `demi`
/// parses to `NaN`.
pub fn parse_number_pattern(m: &str) -> f64 {
    let num = m.to_lowercase();
    if let Some(v) = dict_get(INTEGER_WORD_DICTIONARY, &num) {
        return v as f64;
    }
    if num == "un" || num == "una" || num == "uno" {
        return 1.0;
    }
    if js_regex!(r"algunos?").is_match(&num) {
        return 3.0;
    }
    if js_regex!(r"unos?").is_match(&num) {
        return 3.0;
    }
    if js_regex!(r"media?").is_match(&num) {
        return 0.5;
    }
    js_parse_float(&num)
}

//-----------------------------

pub static ORDINAL_NUMBER_PATTERN: LazyLock<String> = LazyLock::new(|| {
    format!(
        r"(?:{}|[0-9]{{1,2}}(?:º|ª|°|ro|do|to|mo|er|vo|no|ma|era|ero|avo|ava)?)",
        match_any_pattern(dict_keys(ORDINAL_WORD_DICTIONARY))
    )
});

/// `parseOrdinalNumberPattern(match)`. `None` is `NaN`.
pub fn parse_ordinal_number_pattern(m: &str) -> Option<i64> {
    let num = m.to_lowercase();
    if let Some(v) = dict_get(ORDINAL_WORD_DICTIONARY, &num) {
        return Some(v);
    }
    let stripped = js_regex!(r"(?:º|ª|°|ro|do|to|mo|er|vo|no|ma|era|ero|avo|ava)$", "i")
        .exec(&num)
        .map_or(num.as_str(), |mm| &num[..mm.index]);
    js_parse_int(stripped)
}

//-----------------------------
// 88 p. Chr. n.
// 234 AC
pub const YEAR_PATTERN: &str = r"[0-9]{1,4}(?![^\s]\d)(?:\s*[a|d]\.?\s*c\.?|\s*a\.?\s*d\.?)?";

/// `match.replace(regex, "")` for a non-global regex: removes the first match only.
fn replace_first(text: &str, m: Option<RegexMatch>) -> String {
    match m {
        Some(m) => format!("{}{}", &text[..m.index], &text[m.index + m.text().len()..]),
        None => text.to_string(),
    }
}

/// `parseYear(match)`. `None` is `NaN`.
pub fn parse_year(m: &str) -> Option<i64> {
    if js_regex!(r"^[0-9]{1,4}$").is_match(m) {
        let mut year_number = js_parse_int(m)?;
        if year_number < 100 {
            if year_number > 50 {
                year_number += 1900;
            } else {
                year_number += 2000;
            }
        }
        return Some(year_number);
    }

    let bc = js_regex!(r"a\.?\s*c\.?", "i");
    if bc.is_match(m) {
        return js_parse_int(&replace_first(m, bc.exec(m))).map(|y| -y);
    }

    js_parse_int(m)
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
    // The regex only matches dictionary keys (case-folded), so the lowercased lookup succeeds.
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
    fn dictionary_sizes_match_upstream() {
        assert_eq!(WEEKDAY_DICTIONARY.len(), 18);
        assert_eq!(FULL_MONTH_NAME_DICTIONARY.len(), 13);
        assert_eq!(MONTH_DICTIONARY.len(), 37);
        assert_eq!(&MONTH_DICTIONARY[..13], FULL_MONTH_NAME_DICTIONARY);
        assert_eq!(INTEGER_WORD_DICTIONARY.len(), 13);
        assert_eq!(ORDINAL_WORD_DICTIONARY.len(), 60);
        assert_eq!(TIME_UNIT_DICTIONARY.len(), 26);
    }

    #[test]
    fn patterns_match_upstream_exactly() {
        let number = r"(?:(?:cuatro|cinco|siete|nueve|trece|tres|seis|ocho|diez|once|doce|uno|dos)|[0-9]+|[0-9]+\.[0-9]+|un?|uno?|una?|algunos?|unos?|demi-?)";
        assert_eq!(*NUMBER_PATTERN, number);
        let ordinal = r"(?:(?:trigésimo primero|trigesimo primero|vigésimo primero|vigesimo primero|vigésimo segundo|vigesimo segundo|vigésimo tercero|vigesimo tercero|vigésimo séptimo|vigesimo septimo|vigésimo cuarto|vigesimo cuarto|vigésimo quinto|vigesimo quinto|vigésimo octavo|vigesimo octavo|vigésimo noveno|vigesimo noveno|vigésimo sexto|vigesimo sexto|decimotercero|decimoséptimo|decimoseptimo|decimocuarto|decimoquinto|decimonoveno|decimosexto|decimoctavo|duodécimo|duodecimo|trigésimo|trigesimo|undécimo|undecimo|vigésimo|vigesimo|primero|primera|segundo|segunda|tercero|tercera|séptimo|septimo|séptima|septima|cuarto|cuarta|quinto|quinta|octavo|octava|noveno|novena|décimo|decimo|décima|decima|sexto|sexta)|[0-9]{1,2}(?:º|ª|°|ro|do|to|mo|er|vo|no|ma|era|ero|avo|ava)?)";
        assert_eq!(*ORDINAL_NUMBER_PATTERN, ordinal);
        let units = r"(?:(?:segundos|segundo|minutos|semanas|cuartos|minuto|semana|cuarto|horas|meses|mins|hora|días|dias|años|anos|sec|min|hrs|día|dia|mes|año|ano|hr|h))";
        let single = format!(r"(?:{number})\s{{0,5}}{units}\s{{0,5}}");
        assert_eq!(
            *TIME_UNITS_PATTERN,
            format!(r"{single}(?:\s{{0,5}},?\s{{0,5}}{single}){{0,10}}")
        );
        assert_eq!(
            YEAR_PATTERN,
            r"[0-9]{1,4}(?![^\s]\d)(?:\s*[a|d]\.?\s*c\.?|\s*a\.?\s*d\.?)?"
        );
        for p in [
            &*NUMBER_PATTERN,
            &*TIME_UNITS_PATTERN,
            &*ORDINAL_NUMBER_PATTERN,
            YEAR_PATTERN,
        ] {
            JsRegex::new(p, "i");
        }
    }

    #[test]
    fn patterns_match_accented_text_case_insensitively() {
        let ordinal = JsRegex::new(&format!("^{}$", *ORDINAL_NUMBER_PATTERN), "i");
        for s in ["VIGÉSIMO PRIMERO", "décimo", "Séptima", "3era", "1º", "2ª", "15"] {
            assert!(ordinal.is_match(s), "{s}");
        }
        let units = JsRegex::new(&format!("^{}$", *TIME_UNITS_PATTERN), "i");
        for s in ["5 DÍAS", "1 año, 2 meses", "algunos días", "3h 20min"] {
            assert!(units.is_match(s), "{s}");
        }
        let year = JsRegex::new(&format!("^{YEAR_PATTERN}$"), "i");
        for s in ["2012", "234 a.C.", "88 d.C.", "300 a.d."] {
            assert!(year.is_match(s), "{s}");
        }
    }

    #[test]
    fn numbers() {
        for (s, v) in [
            ("uno", 1.0),
            ("Uno", 1.0),
            ("un", 1.0),
            ("una", 1.0),
            ("UNA", 1.0),
            ("dos", 2.0),
            ("trece", 13.0),
            ("DOCE", 12.0),
            ("once", 11.0),
            ("algunos", 3.0),
            ("alguno", 3.0),
            ("unos", 3.0),
            ("media", 0.5),
            ("medio", 0.5),
            ("2.5", 2.5),
            ("12", 12.0),
        ] {
            assert_eq!(parse_number_pattern(s), v, "{s}");
        }
        for s in ["demi", "demi-", "x", "u"] {
            assert!(parse_number_pattern(s).is_nan(), "{s}");
        }
    }

    #[test]
    fn ordinals() {
        for (s, v) in [
            ("primero", Some(1)),
            ("Primera", Some(1)),
            ("vigésimo primero", Some(21)),
            ("VIGÉSIMO PRIMERO", Some(21)),
            ("trigesimo primero", Some(31)),
            ("décimo", Some(10)),
            ("decimo", Some(10)),
            ("1º", Some(1)),
            ("2ª", Some(2)),
            ("3°", Some(3)),
            ("1ro", Some(1)),
            ("2do", Some(2)),
            ("4to", Some(4)),
            ("7mo", Some(7)),
            ("3er", Some(3)),
            ("8vo", Some(8)),
            ("9no", Some(9)),
            ("1ra", Some(1)),
            ("1ma", Some(1)),
            ("3era", Some(3)),
            ("1ero", Some(1)),
            ("8avo", Some(8)),
            ("8ava", Some(8)),
            ("15", Some(15)),
            ("31", Some(31)),
            ("1ER", Some(1)),
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
            ("5", Some(2005)),
            ("0", Some(2000)),
            ("99", Some(1999)),
            ("100", Some(100)),
            ("1900", Some(1900)),
            ("234 AC", Some(-234)),
            ("234 a.C.", Some(-234)),
            ("234 a. c.", Some(-234)),
            ("234 A.C", Some(-234)),
            ("88 d.C.", Some(88)),
            ("88 dc", Some(88)),
            ("2012 ad", Some(2012)),
            ("300 a.d.", Some(300)),
            ("12345", Some(12345)),
            ("-12", Some(-12)),
            ("ac", None),
        ] {
            assert_eq!(parse_year(s), v, "{s}");
        }
    }

    #[test]
    fn durations() {
        let d = |pairs: &[(DurationUnit, f64)]| Duration::from_pairs(pairs);
        assert_eq!(parse_duration("5 días"), d(&[(Day, 5.0)]));
        assert_eq!(parse_duration("5 dias"), d(&[(Day, 5.0)]));
        assert_eq!(parse_duration("2 horas 30 minutos"), d(&[(Hour, 2.0), (Minute, 30.0)]));
        assert_eq!(parse_duration("un mes"), d(&[(Month, 1.0)]));
        assert_eq!(parse_duration("una semana"), d(&[(Week, 1.0)]));
        assert_eq!(parse_duration("3h 20min"), d(&[(Hour, 3.0), (Minute, 20.0)]));
        assert_eq!(parse_duration("1 año, 2 meses"), d(&[(Year, 1.0), (Month, 2.0)]));
        assert_eq!(parse_duration("algunos días"), d(&[(Day, 3.0)]));
        assert_eq!(parse_duration("dos cuartos"), d(&[(Quarter, 2.0)]));
        assert_eq!(parse_duration("10 segundos"), d(&[(Second, 10.0)]));
        assert_eq!(parse_duration("1.5 horas"), d(&[(Hour, 1.5)]));
        assert_eq!(parse_duration("uno dia"), d(&[(Day, 1.0)]));
        assert_eq!(parse_duration("DOS AÑOS"), d(&[(Year, 2.0)]));
        assert_eq!(parse_duration("unos minutos"), d(&[(Minute, 3.0)]));
        // "media" isn't in NUMBER_PATTERN, so nothing matches.
        assert_eq!(parse_duration("media hora"), Duration::new());
        assert_eq!(parse_duration("días"), Duration::new());
        assert_eq!(parse_duration("1 an"), Duration::new());
        // "demi" matches NUMBER_PATTERN but parses to NaN: upstream gives `{ hour: NaN }`.
        let demi = parse_duration("demi hora");
        assert_eq!(demi.iter().count(), 1);
        assert!(demi.get(Hour).is_some_and(f64::is_nan));
    }

    /// ESMonthNameParser's `DATE_PREFIX_PATTERN` is a JS `iu` regex (`\p{L}`): `JsRegex` must take it.
    #[test]
    fn month_name_date_prefix_pattern_unicode_mode() {
        let o = &*ORDINAL_NUMBER_PATTERN;
        let re = JsRegex::new(
            &format!(
                r"(?:^|[^\p{{L}}\p{{N}}\p{{M}}_]){o}(?:\s*(?:desde|de|-|–|ao?|\s)\s*{o})?\s*(?:de)?\s*(?:-|/|\s*(?:de|,)?\s*)$"
            ),
            "iu",
        );
        for (s, v) in [
            ("el 5 de ", Some((2, " 5 de "))),
            ("primero de ", Some((0, "primero de "))),
            ("Vigésimo Primero de ", Some((0, "Vigésimo Primero de "))),
            ("del 3 al 5 de", Some((8, " 5 de"))),
            ("10/", Some((0, "10/"))),
            ("x5 de ", None),
            ("é12 de ", None),
            ("hola ", None),
        ] {
            let got = re.exec(s).map(|m| (m.index, m.text().to_string()));
            assert_eq!(got, v.map(|(i, t)| (i, t.to_string())), "{s:?}");
        }
    }
}
