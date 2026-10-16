//! JavaScript regular expressions on top of `fancy-regex`.
//!
//! Port patterns **verbatim from the TypeScript source** (the text between `/.../` or inside
//! `new RegExp("...")` after JS string unescaping) and pass the JS flags. `JsRegex` translates
//! the parts where JS and Rust differ:
//!
//! | JS (no `u` flag) | Rust default | Translation |
//! |---|---|---|
//! | `\d`, `\w`, `\b` are ASCII-only | Unicode-aware | explicit ASCII classes; `\b` as lookarounds |
//! | `\s` is a fixed set incl. U+FEFF | Unicode `White_Space` | the JS set, listed explicitly |
//! | `.` excludes `\n \r U+2028 U+2029` | excludes `\n` only | explicit class |
//! | `\–` (escaped non-ASCII) is a literal | error | the literal character |
//! | `[`, `&&`, `--`, `~~` in a class are literals | class syntax | escaped |
//! | lookahead/lookbehind, backreferences | unsupported in `regex` | `fancy-regex` handles them |
//!
//! Known, accepted difference: with the `i` flag, Rust also folds a few non-ASCII letters onto
//! ASCII ones (U+212A KELVIN SIGN matches `k`, U+017F LONG S matches `s`). JS doesn't.

use fancy_regex::Regex;

const JS_WHITESPACE: &str =
    r"\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";
const WORD: &str = "A-Za-z0-9_";
const NON_WORD_IN_CLASS: &str = r"\x{0}-\x{2F}\x{3A}-\x{40}\x{5B}-\x{5E}\x{60}\x{7B}-\x{10FFFF}";
const NON_DIGIT_IN_CLASS: &str = r"\x{0}-\x{2F}\x{3A}-\x{10FFFF}";
const WORD_BOUNDARY: &str = r"(?:(?<=[A-Za-z0-9_])(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])(?=[A-Za-z0-9_]))";
const NOT_WORD_BOUNDARY: &str = r"(?:(?<=[A-Za-z0-9_])(?=[A-Za-z0-9_])|(?<![A-Za-z0-9_])(?![A-Za-z0-9_]))";
const META: &str = r"\.+*?()|[]{}^$#&-~";

/// A compiled JS regular expression.
#[derive(Clone, Debug)]
pub struct JsRegex {
    source: String,
    flags: String,
    re: Regex,
}

/// The result of `RegExp.prototype.exec`: `index` is a **byte** offset into the searched text,
/// and `groups[i]` is `match[i]` (`None` = `undefined`, a group that didn't participate).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RegexMatch {
    pub index: usize,
    pub groups: Vec<Option<String>>,
}

impl RegexMatch {
    /// `match[i]`, or `None` if undefined or out of range.
    pub fn get(&self, i: usize) -> Option<&str> {
        self.groups.get(i).and_then(|g| g.as_deref())
    }

    /// `match[0]`.
    pub fn text(&self) -> &str {
        self.get(0).unwrap_or("")
    }

    /// `match.length`.
    pub fn len(&self) -> usize {
        self.groups.len()
    }

    pub fn is_empty(&self) -> bool {
        self.groups.is_empty()
    }
}

impl JsRegex {
    /// Compiles a JS pattern. Panics on an invalid pattern: patterns are constants, and every one
    /// is compiled by the unit tests of the module that owns it.
    pub fn new(source: &str, flags: &str) -> JsRegex {
        JsRegex::try_new(source, flags).unwrap_or_else(|e| panic!("invalid JS regex /{source}/{flags}: {e}"))
    }

    pub fn try_new(source: &str, flags: &str) -> Result<JsRegex, String> {
        let translated = translate(source, flags)?;
        let re = Regex::new(&translated).map_err(|e| format!("{e} (translated: {translated})"))?;
        Ok(JsRegex {
            source: source.to_string(),
            flags: flags.to_string(),
            re,
        })
    }

    /// `regex.source`: the original JS pattern text.
    pub fn source(&self) -> &str {
        &self.source
    }

    /// `regex.flags`.
    pub fn flags(&self) -> &str {
        &self.flags
    }

    /// `regex.exec(text)` for a non-global regex: the first match, searching from the start.
    /// A backtracking-limit error counts as "no match".
    pub fn exec(&self, text: &str) -> Option<RegexMatch> {
        let caps = self.re.captures(text).ok()??;
        let index = caps.get(0)?.start();
        let groups = (0..caps.len())
            .map(|i| caps.get(i).map(|m| m.as_str().to_string()))
            .collect();
        Some(RegexMatch { index, groups })
    }

    /// `regex.test(text)`, or the truthiness of `text.match(regex)`.
    pub fn is_match(&self, text: &str) -> bool {
        self.re.is_match(text).unwrap_or(false)
    }
}

/// A lazily compiled `&'static JsRegex`: `js_regex!(r"(\d+)\s*days?", "i")`.
#[macro_export]
macro_rules! js_regex {
    ($source:expr) => {
        $crate::js_regex!($source, "")
    };
    ($source:expr, $flags:expr) => {{
        static RE: std::sync::LazyLock<$crate::core::regex::JsRegex> =
            std::sync::LazyLock::new(|| $crate::core::regex::JsRegex::new($source, $flags));
        &*RE
    }};
}

fn push_literal(out: &mut String, c: char) {
    if META.contains(c) {
        out.push('\\');
    }
    out.push(c);
}

fn hex_digits(chars: &[char], start: usize, count: usize) -> Option<String> {
    let s: String = chars.get(start..start + count)?.iter().collect();
    s.chars().all(|c| c.is_ascii_hexdigit()).then_some(s)
}

/// Length of a `{n}`, `{n,}` or `{n,m}` quantifier starting at `chars[i] == '{'`, if valid.
fn quantifier_len(chars: &[char], i: usize) -> Option<usize> {
    let mut j = i + 1;
    let digits_start = j;
    while j < chars.len() && chars[j].is_ascii_digit() {
        j += 1;
    }
    if j == digits_start {
        return None;
    }
    if chars.get(j) == Some(&',') {
        j += 1;
        while j < chars.len() && chars[j].is_ascii_digit() {
            j += 1;
        }
    }
    (chars.get(j) == Some(&'}')).then_some(j - i + 1)
}

/// Translates JS regex source (non-unicode mode) to `fancy-regex` syntax.
pub fn translate(source: &str, flags: &str) -> Result<String, String> {
    let mut out = String::new();
    let mut inline = String::new();
    for f in flags.chars() {
        match f {
            'i' | 'm' | 's' => inline.push(f),
            'g' | 'y' | 'd' => return Err(format!("flag '{f}' changes exec() state; not supported")),
            'u' | 'v' => return Err(format!("flag '{f}' (unicode mode) is not supported")),
            _ => return Err(format!("unknown flag '{f}'")),
        }
    }
    if !inline.is_empty() {
        out.push_str(&format!("(?{inline})"));
    }

    let chars: Vec<char> = source.chars().collect();
    let n = chars.len();
    let mut in_class = false;
    let mut i = 0;
    while i < n {
        let c = chars[i];
        if c == '\\' {
            i += 1;
            let Some(&e) = chars.get(i) else {
                return Err("trailing backslash".into());
            };
            match e {
                'd' => out.push_str(if in_class { "0-9" } else { "[0-9]" }),
                'D' => {
                    if in_class {
                        out.push_str(NON_DIGIT_IN_CLASS)
                    } else {
                        out.push_str("[^0-9]")
                    }
                }
                'w' => {
                    if in_class {
                        out.push_str(WORD)
                    } else {
                        out.push_str(&format!("[{WORD}]"))
                    }
                }
                'W' => {
                    if in_class {
                        out.push_str(NON_WORD_IN_CLASS)
                    } else {
                        out.push_str(&format!("[^{WORD}]"))
                    }
                }
                's' => {
                    if in_class {
                        out.push_str(JS_WHITESPACE)
                    } else {
                        out.push_str(&format!("[{JS_WHITESPACE}]"))
                    }
                }
                'S' => {
                    if in_class {
                        return Err(r"\S inside a character class is not supported".into());
                    }
                    out.push_str(&format!("[^{JS_WHITESPACE}]"));
                }
                'b' => out.push_str(if in_class { r"\x{8}" } else { WORD_BOUNDARY }),
                'B' => {
                    if in_class {
                        return Err(r"\B inside a character class".into());
                    }
                    out.push_str(NOT_WORD_BOUNDARY);
                }
                'n' => out.push_str(r"\n"),
                'r' => out.push_str(r"\r"),
                't' => out.push_str(r"\t"),
                'f' => out.push_str(r"\x{C}"),
                'v' => out.push_str(r"\x{B}"),
                'u' => match hex_digits(&chars, i + 1, 4) {
                    Some(h) => {
                        out.push_str(&format!(r"\x{{{h}}}"));
                        i += 4;
                    }
                    None => out.push('u'),
                },
                'x' => match hex_digits(&chars, i + 1, 2) {
                    Some(h) => {
                        out.push_str(&format!(r"\x{{{h}}}"));
                        i += 2;
                    }
                    None => out.push('x'),
                },
                '0' if !chars.get(i + 1).is_some_and(|d| d.is_ascii_digit()) => out.push_str(r"\x{0}"),
                '1'..='9' if !in_class => {
                    out.push('\\');
                    out.push(e);
                    while chars.get(i + 1).is_some_and(|d| d.is_ascii_digit()) {
                        i += 1;
                        out.push(chars[i]);
                    }
                }
                'c' | 'k' | 'p' | 'P' => return Err(format!(r"\{e} is not supported")),
                // Identity escapes: `\-`, `\.`, `\/`, `\–`, `\：` ... are the literal character.
                other => push_literal(&mut out, other),
            }
            i += 1;
            continue;
        }

        if in_class {
            match c {
                ']' => {
                    in_class = false;
                    out.push(']');
                }
                '[' | '&' | '~' => {
                    out.push('\\');
                    out.push(c);
                }
                '-' if chars.get(i + 1) == Some(&'-') => out.push_str(r"\-"),
                _ => out.push(c),
            }
            i += 1;
            continue;
        }

        match c {
            '[' => {
                if chars.get(i + 1) == Some(&']') || (chars.get(i + 1) == Some(&'^') && chars.get(i + 2) == Some(&']'))
                {
                    return Err("empty character classes ([] or [^]) are not supported".into());
                }
                in_class = true;
                out.push('[');
                if chars.get(i + 1) == Some(&'^') {
                    out.push('^');
                    i += 1;
                }
            }
            '.' => out.push_str(r"[^\n\r\x{2028}\x{2029}]"),
            '(' if chars.get(i + 1) == Some(&'?')
                && chars.get(i + 2) == Some(&'<')
                && !matches!(chars.get(i + 3), Some('=') | Some('!')) =>
            {
                out.push_str("(?P<");
                i += 3;
                continue;
            }
            '{' => match quantifier_len(&chars, i) {
                Some(len) => {
                    out.extend(&chars[i..i + len]);
                    i += len;
                    continue;
                }
                None => out.push_str(r"\{"),
            },
            '}' => out.push_str(r"\}"),
            _ => out.push(c),
        }
        i += 1;
    }
    if in_class {
        return Err("unterminated character class".into());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(src: &str, flags: &str, text: &str) -> Option<(usize, Vec<Option<String>>)> {
        JsRegex::new(src, flags).exec(text).map(|m| (m.index, m.groups))
    }

    #[test]
    fn ascii_classes_like_js() {
        assert!(JsRegex::new(r"^\w+$", "").is_match("abc_09"));
        assert!(!JsRegex::new(r"^\w+$", "").is_match("café"));
        assert!(!JsRegex::new(r"^\d$", "").is_match("٣")); // Arabic-Indic digit
        assert!(JsRegex::new(r"^\W$", "").is_match("é"));
        assert!(JsRegex::new(r"^[\W]$", "").is_match("é"));
        assert!(!JsRegex::new(r"^[\W]$", "").is_match("a"));
        assert!(JsRegex::new(r"^[\D]$", "").is_match("x"));
    }

    #[test]
    fn whitespace_and_dot_like_js() {
        assert!(JsRegex::new(r"^\s$", "").is_match("\u{FEFF}"));
        assert!(JsRegex::new(r"^\s$", "").is_match("\u{3000}"));
        assert!(!JsRegex::new(r"^\s$", "").is_match("\u{85}")); // NEL is not JS whitespace
        assert!(!JsRegex::new(r"^.$", "").is_match("\r"));
        assert!(!JsRegex::new(r"^.$", "").is_match("\u{2028}"));
        assert!(JsRegex::new(r"^.$", "").is_match("é"));
    }

    #[test]
    fn word_boundary_is_ascii() {
        // "é" is not a JS word character, so there is a boundary between "caf" and "é".
        assert_eq!(m(r"caf\b", "", "café"), Some((0, vec![Some("caf".into())])));
        assert_eq!(m(r"\bnow\b", "i", "right NOW!"), Some((6, vec![Some("NOW".into())])));
        assert!(JsRegex::new(r"a\Bb", "").is_match("ab"));
    }

    #[test]
    fn lookaround_and_groups() {
        // The ENCasualDateParser pattern, with lookahead and a left-boundary group.
        let re = JsRegex::new(r"(\W|^)(now|today|tonight|last\s*night)(?=\W|$)", "i");
        let mm = re.exec("see you Tonight.").unwrap();
        assert_eq!(mm.index, 7);
        assert_eq!(
            mm.groups,
            vec![Some(" Tonight".into()), Some(" ".into()), Some("Tonight".into())]
        );
        assert!(re.exec("nowhere").is_none());
        // Undefined optional groups are None.
        let mm = JsRegex::new(r"(a)(b)?", "").exec("a").unwrap();
        assert_eq!(mm.get(2), None);
        assert_eq!(mm.len(), 3);
        assert!(JsRegex::new(r"(?<!x)y", "").is_match("ay"));
    }

    #[test]
    fn escapes_and_literals() {
        assert!(JsRegex::new(r"^\–\〜\：$", "").is_match("–〜："));
        assert!(JsRegex::new(r"^\/\-\.$", "").is_match("/-."));
        assert!(JsRegex::new(r"^[\-\–~&]+$", "").is_match("-–~&"));
        assert!(JsRegex::new(r"^\u00e9\x41$", "").is_match("éA"));
        assert!(JsRegex::new(r"^a{2,3}$", "").is_match("aaa"));
        assert!(JsRegex::new(r"^{x}$", "").is_match("{x}"));
        assert!(JsRegex::new(r"^(?<word>ab)\1$", "").is_match("abab"));
        assert!(JsRegex::new(r"^[\[\]]+$", "").is_match("[]"));
    }

    #[test]
    fn rejects_unsupported() {
        assert!(JsRegex::try_new("a", "g").is_err());
        assert!(JsRegex::try_new("a", "u").is_err());
        assert!(JsRegex::try_new("[]", "").is_err());
    }

    #[test]
    fn case_insensitive_flag() {
        assert!(JsRegex::new(r"^TODAY$", "i").is_match("today"));
        assert!(!JsRegex::new(r"^TODAY$", "").is_match("today"));
    }
}
