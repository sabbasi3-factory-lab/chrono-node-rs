//! JavaScript string and number built-ins that upstream code relies on.
//!
//! Use these instead of Rust equivalents when porting: they differ in edge cases
//! (`parseInt("12px")` is 12; `" x\u{FEFF}".trim()` removes the BOM; `substring` counts UTF-16 units).

/// JS `WhiteSpace` + `LineTerminator`, as used by `String.prototype.trim`.
pub fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{B}' | '\u{C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}'
    )
}

/// `s.trim()`.
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_whitespace)
}

/// `parseInt(s)` (radix 10). `None` is `NaN`. Saturates instead of losing precision past `i64`.
pub fn js_parse_int(s: &str) -> Option<i64> {
    let s = s.trim_start_matches(is_js_whitespace);
    let (negative, digits) = match s.as_bytes().first() {
        Some(b'-') => (true, &s[1..]),
        Some(b'+') => (false, &s[1..]),
        _ => (false, s),
    };
    let end = digits.bytes().position(|b| !b.is_ascii_digit()).unwrap_or(digits.len());
    if end == 0 {
        return None;
    }
    let mut value: i64 = 0;
    for b in digits[..end].bytes() {
        value = value.saturating_mul(10).saturating_add((b - b'0') as i64);
    }
    Some(if negative { -value } else { value })
}

/// `parseFloat(s)`. Returns `NaN` if no number prefix.
pub fn js_parse_float(s: &str) -> f64 {
    let s = s.trim_start_matches(is_js_whitespace);
    let bytes = s.as_bytes();
    let mut i = 0;
    if matches!(bytes.first(), Some(b'+') | Some(b'-')) {
        i = 1;
    }
    if s[i..].starts_with("Infinity") {
        return if bytes[0] == b'-' {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    let int_start = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    let mut digits = i - int_start;
    if i < bytes.len() && bytes[i] == b'.' {
        let frac_start = i + 1;
        let mut j = frac_start;
        while j < bytes.len() && bytes[j].is_ascii_digit() {
            j += 1;
        }
        digits += j - frac_start;
        if digits > 0 {
            i = j;
        }
    }
    if digits == 0 {
        return f64::NAN;
    }
    if i < bytes.len() && (bytes[i] == b'e' || bytes[i] == b'E') {
        let mut j = i + 1;
        if j < bytes.len() && (bytes[j] == b'+' || bytes[j] == b'-') {
            j += 1;
        }
        let exp_start = j;
        while j < bytes.len() && bytes[j].is_ascii_digit() {
            j += 1;
        }
        if j > exp_start {
            i = j;
        }
    }
    s[..i].parse().unwrap_or(f64::NAN)
}

/// Byte offset of the `units`-th UTF-16 code unit in `s` (clamped to the end, and moved forward
/// to a char boundary if it falls inside a surrogate pair).
pub fn utf16_to_byte_offset(s: &str, units: usize) -> usize {
    let mut seen = 0;
    for (byte, c) in s.char_indices() {
        if seen >= units {
            return byte;
        }
        seen += c.len_utf16();
    }
    s.len()
}

/// `s.substring(start)` where `start` counts UTF-16 units.
pub fn js_substring_from(s: &str, start_utf16: usize) -> &str {
    &s[utf16_to_byte_offset(s, start_utf16)..]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_int_like_js() {
        assert_eq!(js_parse_int("12px"), Some(12));
        assert_eq!(js_parse_int("  -7"), Some(-7));
        assert_eq!(js_parse_int("x1"), None);
        assert_eq!(js_parse_int("007"), Some(7));
    }

    #[test]
    fn parse_float_like_js() {
        assert_eq!(js_parse_float("2.5 days"), 2.5);
        assert_eq!(js_parse_float(".5"), 0.5);
        assert_eq!(js_parse_float("3."), 3.0);
        assert_eq!(js_parse_float("1e3x"), 1000.0);
        assert_eq!(js_parse_float("1ex"), 1.0);
        assert!(js_parse_float("few").is_nan());
        assert!(js_parse_float(".").is_nan());
    }

    #[test]
    fn trim_and_substring() {
        assert_eq!(js_trim("\u{FEFF} a \u{3000}"), "a");
        assert_eq!(js_substring_from("😀ab", 2), "ab");
        assert_eq!(js_substring_from("ab", 5), "");
    }
}
