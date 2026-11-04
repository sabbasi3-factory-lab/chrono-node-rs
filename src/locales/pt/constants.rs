//! upstream `locales/pt/constants.ts`. Ported in full so parser tasks don't edit this file.
//!
//! Dictionaries are `(key, value)` slices **in upstream's key order**. It matters:
//! `match_any_pattern` sorts stably, so equal-length keys keep this order.

use crate::core::utils::js::js_parse_int;
use crate::core::utils::pattern::Dictionary;
use crate::js_regex;

pub static WEEKDAY_DICTIONARY: &Dictionary<i64> = &[
    ("domingo", 0),
    ("dom", 0),
    ("segunda", 1),
    ("segunda-feira", 1),
    ("seg", 1),
    ("terça", 2),
    ("terça-feira", 2),
    ("ter", 2),
    ("quarta", 3),
    ("quarta-feira", 3),
    ("qua", 3),
    ("quinta", 4),
    ("quinta-feira", 4),
    ("qui", 4),
    ("sexta", 5),
    ("sexta-feira", 5),
    ("sex", 5),
    ("sábado", 6),
    ("sabado", 6),
    ("sab", 6),
];

pub static MONTH_DICTIONARY: &Dictionary<i64> = &[
    ("janeiro", 1),
    ("jan", 1),
    ("jan.", 1),
    ("fevereiro", 2),
    ("fev", 2),
    ("fev.", 2),
    ("março", 3),
    ("mar", 3),
    ("mar.", 3),
    ("abril", 4),
    ("abr", 4),
    ("abr.", 4),
    ("maio", 5),
    ("mai", 5),
    ("mai.", 5),
    ("junho", 6),
    ("jun", 6),
    ("jun.", 6),
    ("julho", 7),
    ("jul", 7),
    ("jul.", 7),
    ("agosto", 8),
    ("ago", 8),
    ("ago.", 8),
    ("setembro", 9),
    ("set", 9),
    ("set.", 9),
    ("outubro", 10),
    ("out", 10),
    ("out.", 10),
    ("novembro", 11),
    ("nov", 11),
    ("nov.", 11),
    ("dezembro", 12),
    ("dez", 12),
    ("dez.", 12),
];

//-----------------------------
// 88 p. Chr. n.
// 234 AC
pub const YEAR_PATTERN: &str = r"[0-9]{1,4}(?![^\s]\d)(?:\s*[a|d]\.?\s*c\.?|\s*a\.?\s*d\.?)?";

/// `parseYear(match)`. `None` is `NaN`.
pub fn parse_year(m: &str) -> Option<i64> {
    if js_regex!(r"^[0-9]{1,4}$").is_match(m) {
        // `NaN < 100` is false, so NaN would pass through unchanged (it can't happen here).
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
    if let Some(found) = bc.exec(m) {
        // `match.replace(/a\.?\s*c\.?/i, "")`: the first match only.
        let rest = format!("{}{}", &m[..found.index], &m[found.index + found.text().len()..]);
        return js_parse_int(&rest).map(|y| -y);
    }

    js_parse_int(m)
}

#[cfg(test)]
mod tests {
    //! Expected values were produced by chrono-node v2.10.3 itself (compiled from `upstream/`).
    use super::*;
    use crate::core::regex::JsRegex;

    #[test]
    fn years() {
        for (s, v) in [
            ("2012", Some(2012)),
            ("12", Some(2012)),
            ("51", Some(1951)),
            ("50", Some(2050)),
            ("99", Some(1999)),
            ("100", Some(100)),
            ("0012", Some(2012)),
            ("234 AC", Some(-234)),
            ("234 a.c.", Some(-234)),
            ("234 A. C.", Some(-234)),
            ("88 ad", Some(88)),
            ("88 d.c.", Some(88)),
            ("5 dc", Some(5)),
            (" 12", Some(12)),
            ("abc", None),
        ] {
            assert_eq!(parse_year(s), v, "{s:?}");
        }
    }

    #[test]
    fn year_pattern() {
        let re = JsRegex::new(YEAR_PATTERN, "i");
        for (s, v) in [
            ("2012", "2012"),
            ("234 AC", "234 AC"),
            ("88 d.c.", "88 d.c."),
            ("1999x", "1999"),
            ("12 a.d.", "12 a.d."),
            // `[a|d]` is a character class that includes `|`.
            ("12 |c", "12 |c"),
        ] {
            assert_eq!(re.exec(s).map(|m| m.text().to_string()).as_deref(), Some(v), "{s:?}");
        }
    }
}
