//! upstream `utils/pattern.ts`.

/// JS `string.length`: UTF-16 code units. Use it wherever upstream compares or sorts by length.
pub fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `repeatedTimeunitPattern(prefix, singleTimeunitPattern, connectorPattern)`.
pub fn repeated_timeunit_pattern(
    prefix: &str,
    single_timeunit_pattern: &str,
    connector_pattern: Option<&str>,
) -> String {
    let connector = connector_pattern.unwrap_or(r"\s{0,5},?\s{0,5}");
    // `.replace(/\((?!\?)/g, "(?:")`: every "(" not followed by "?" becomes non-capturing.
    let chars: Vec<char> = single_timeunit_pattern.chars().collect();
    let mut no_capture = String::new();
    for (i, &c) in chars.iter().enumerate() {
        if c == '(' && chars.get(i + 1) != Some(&'?') {
            no_capture.push_str("(?:");
        } else {
            no_capture.push(c);
        }
    }
    format!("{prefix}{no_capture}(?:{connector}{no_capture}){{0,10}}")
}

/// `matchAnyPattern(dictionary)`: pass the dictionary keys **in upstream's key order**.
/// Longest first (stable sort, so equal lengths keep that order), joined with `|`, dots escaped.
pub fn match_any_pattern<'a>(terms: impl IntoIterator<Item = &'a str>) -> String {
    let mut terms: Vec<&str> = terms.into_iter().collect();
    terms.sort_by_key(|t| std::cmp::Reverse(js_len(t)));
    format!("(?:{})", terms.join("|").replace('.', r"\."))
}

/// An upstream `{ [word: string]: V }` dictionary, as `(key, value)` pairs **in upstream key order**.
pub type Dictionary<V> = [(&'static str, V)];

/// `DICTIONARY[key]` (`None` = `undefined`).
pub fn dict_get<V: Copy>(dictionary: &Dictionary<V>, key: &str) -> Option<V> {
    dictionary.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
}

/// `Object.keys(DICTIONARY)`.
pub fn dict_keys<V>(dictionary: &Dictionary<V>) -> impl Iterator<Item = &'static str> + '_ {
    dictionary.iter().map(|(k, _)| *k)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn any_pattern_sorts_longest_first_stably() {
        assert_eq!(
            match_any_pattern(["mon", "monday", "tue", "sept."]),
            r"(?:monday|sept\.|mon|tue)"
        );
    }

    #[test]
    fn repeated_pattern() {
        assert_eq!(
            repeated_timeunit_pattern("", "(a)(?:b)", Some(",")),
            "(?:a)(?:b)(?:,(?:a)(?:b)){0,10}"
        );
    }

    #[test]
    fn js_length_counts_utf16() {
        assert_eq!(js_len("a😀"), 3);
    }
}
