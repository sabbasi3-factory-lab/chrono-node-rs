//! upstream `locales/zh/hant/constants.ts`.

use crate::core::utils::js::js_parse_int;
use crate::core::utils::pattern::{dict_get, Dictionary};

pub static NUMBER: &Dictionary<i64> = &[
    ("零", 0),
    ("一", 1),
    ("二", 2),
    ("兩", 2),
    ("三", 3),
    ("四", 4),
    ("五", 5),
    ("六", 6),
    ("七", 7),
    ("八", 8),
    ("九", 9),
    ("十", 10),
    ("廿", 20),
    ("卅", 30),
];

pub static WEEKDAY_OFFSET: &Dictionary<i64> = &[
    ("天", 0),
    ("日", 0),
    ("一", 1),
    ("二", 2),
    ("三", 3),
    ("四", 4),
    ("五", 5),
    ("六", 6),
];

/// `None` is `NaN` (an unknown character poisons the sum).
pub fn zh_string_to_number(text: &str) -> Option<i64> {
    let mut number: Option<i64> = Some(0);

    for c in text.chars() {
        let mut buf = [0u8; 4];
        let value = dict_get(NUMBER, c.encode_utf8(&mut buf));
        number = if c == '十' {
            match number {
                Some(0) => value,
                Some(n) => value.map(|v| n.wrapping_mul(v)),
                None => None,
            }
        } else {
            match (number, value) {
                (Some(n), Some(v)) => Some(n.wrapping_add(v)),
                _ => None,
            }
        };
    }

    number
}

/// `None` is `NaN`. Unknown characters concatenate as `"undefined"`, like upstream.
pub fn zh_string_to_year(text: &str) -> Option<i64> {
    let mut string = String::new();

    for c in text.chars() {
        let mut buf = [0u8; 4];
        match dict_get(NUMBER, c.encode_utf8(&mut buf)) {
            Some(v) => string.push_str(&v.to_string()),
            None => string.push_str("undefined"),
        }
    }

    js_parse_int(&string)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(d: &Dictionary<i64>) -> Vec<(&str, i64)> {
        d.iter().map(|(k, v)| (*k, *v)).collect()
    }

    #[test]
    fn number_matches_upstream() {
        assert_eq!(
            map(NUMBER),
            vec![
                ("零", 0),
                ("一", 1),
                ("二", 2),
                ("兩", 2),
                ("三", 3),
                ("四", 4),
                ("五", 5),
                ("六", 6),
                ("七", 7),
                ("八", 8),
                ("九", 9),
                ("十", 10),
                ("廿", 20),
                ("卅", 30)
            ]
        );
    }

    #[test]
    fn weekday_offset_matches_upstream() {
        assert_eq!(
            map(WEEKDAY_OFFSET),
            vec![
                ("天", 0),
                ("日", 0),
                ("一", 1),
                ("二", 2),
                ("三", 3),
                ("四", 4),
                ("五", 5),
                ("六", 6)
            ]
        );
    }

    #[test]
    fn zh_string_to_number_case_1() {
        assert_eq!(zh_string_to_number("一"), Some(1));
    }

    #[test]
    fn zh_string_to_number_case_2() {
        assert_eq!(zh_string_to_number("1"), None);
    }

    #[test]
    fn zh_string_to_number_case_3() {
        assert_eq!(zh_string_to_number("七"), Some(7));
    }

    #[test]
    fn zh_string_to_number_case_4() {
        assert_eq!(zh_string_to_number("三"), Some(3));
    }

    #[test]
    fn zh_string_to_year_case_1() {
        assert_eq!(zh_string_to_year("一"), Some(1));
    }

    #[test]
    fn zh_string_to_year_case_2() {
        assert_eq!(zh_string_to_year("1"), None);
    }

    #[test]
    fn zh_string_to_year_case_3() {
        assert_eq!(zh_string_to_year("七"), Some(7));
    }

    #[test]
    fn zh_string_to_year_case_4() {
        assert_eq!(zh_string_to_year("三"), Some(3));
    }
}
