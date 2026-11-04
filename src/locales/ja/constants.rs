//! upstream `locales/ja/constants.ts`. Ported in full so parser tasks don't edit this file.
//!
//! Dictionaries are `(key, value)` slices **in upstream's key order** (`Object.keys(NUMBER).join("")`
//! builds regex character classes in that order).

use crate::core::utils::pattern::{dict_get, Dictionary};

pub static NUMBER: &Dictionary<i64> = &[
    ("零", 0),
    ("〇", 0),
    ("一", 1),
    ("二", 2),
    ("三", 3),
    ("四", 4),
    ("五", 5),
    ("六", 6),
    ("七", 7),
    ("八", 8),
    ("九", 9),
    ("十", 10),
];

pub static WEEKDAY_OFFSET: &Dictionary<i64> = &[
    ("日", 0),
    ("月", 1),
    ("火", 2),
    ("水", 3),
    ("木", 4),
    ("金", 5),
    ("土", 6),
];

/// `toHankaku(text)` (to-hankaku.js): full-width ASCII to ASCII.
///
/// Converts `\uFF01`, `\uFF03`-`\uFF06`, `\uFF08`-`\uFF09`, `\uFF0C`-`\uFF19`, `\uFF1C`-`\uFF1F`,
/// `\uFF21`-`\uFF3B`, `\uFF3D`, `\uFF3F`, `\uFF41`-`\uFF5B`, `\uFF5D`-`\uFF5E` by subtracting 65248,
/// plus four single replacements. Others (`：` U+FF1A, `＂` U+FF02, ...) are kept, as upstream.
pub fn to_hankaku(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            '\u{2019}' => '\u{0027}',
            '\u{201D}' => '\u{0022}',
            '\u{3000}' => '\u{0020}',
            '\u{FFE5}' => '\u{00A5}',
            '\u{FF01}'
            | '\u{FF03}'..='\u{FF06}'
            | '\u{FF08}'..='\u{FF09}'
            | '\u{FF0C}'..='\u{FF19}'
            | '\u{FF1C}'..='\u{FF1F}'
            | '\u{FF21}'..='\u{FF3B}'
            | '\u{FF3D}'
            | '\u{FF3F}'
            | '\u{FF41}'..='\u{FF5B}'
            | '\u{FF5D}'..='\u{FF5E}' => char::from_u32(c as u32 - 65248).unwrap_or(c),
            _ => c,
        })
        .collect()
}

/// `jaStringToNumber(text)`. `None` is `NaN` (a character outside `NUMBER`; it stays `NaN`).
pub fn ja_string_to_number(text: &str) -> Option<i64> {
    let mut number: Option<i64> = Some(0);
    // Every key of NUMBER is one UTF-16 unit, and so is every BMP char: iterate chars.
    for c in text.chars() {
        let mut buf = [0u8; 4];
        let key = c.encode_utf8(&mut buf);
        let value = dict_get(NUMBER, key);
        number = if key == "十" {
            match number {
                Some(0) => value,
                n => n.zip(value).map(|(n, v)| n * v),
            }
        } else {
            number.zip(value).map(|(n, v)| n + v)
        };
    }
    number
}

#[cfg(test)]
mod tests {
    //! Expected values were produced by chrono-node v2.10.3 itself (compiled from `upstream/`).
    use super::*;
    use crate::core::utils::pattern::dict_keys;

    #[test]
    fn key_order() {
        assert_eq!(dict_keys(NUMBER).collect::<String>(), "零〇一二三四五六七八九十");
        assert_eq!(dict_keys(WEEKDAY_OFFSET).collect::<String>(), "日月火水木金土");
    }

    #[test]
    fn hankaku() {
        for (s, v) in [
            ("１２", "12"),
            ("２０１２年３月３１日", "2012年3月31日"),
            ("Ａｂｃ！＃＄", "Abc!#$"),
            ("’”　￥", "'\" ¥"),
            ("（月）", "(月)"),
            ("～", "~"),
            ("：", "："),
            ("ー", "ー"),
            ("－", "-"),
            ("12", "12"),
        ] {
            assert_eq!(to_hankaku(s), v, "{s:?}");
        }
    }

    #[test]
    fn kanji_numbers() {
        for (s, v) in [
            ("一", Some(1)),
            ("十", Some(10)),
            ("十二", Some(12)),
            ("二十", Some(20)),
            ("二十三", Some(23)),
            ("三十五", Some(35)),
            ("百", None),
            ("〇", Some(0)),
            ("零", Some(0)),
            ("十十", Some(100)),
            ("一十", Some(10)),
            ("二二", Some(4)),
            ("", Some(0)),
        ] {
            assert_eq!(ja_string_to_number(s), v, "{s:?}");
        }
    }
}
