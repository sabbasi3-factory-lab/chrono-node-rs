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
//! | `i` compares `Canonicalize(ch)`: the single-unit uppercase, never non-ASCII → ASCII, BMP only | Unicode simple case folding (U+017F LONG S ~ `s`, U+212A KELVIN SIGN ~ `k`, ...) | no `(?i)`: each literal becomes its JS-equivalence set, each class is closed under it |
//!
//! With `i`, backreferences are rejected (JS compares them canonicalized; no ported pattern uses one).

use std::collections::HashMap;
use std::sync::LazyLock;

use fancy_regex::Regex;

/// JS `Canonicalize(ch)` for a non-unicode, case-insensitive regex (ECMA-262 §22.2.2.7.3): the
/// uppercase of the single UTF-16 code unit if it is one code unit, unless that maps a non-ASCII
/// character onto ASCII. Astral characters (surrogate pairs in JS) never fold.
fn js_canonicalize(c: char) -> char {
    if c as u32 > 0xFFFF {
        return c;
    }
    let mut up = c.to_uppercase();
    match (up.next(), up.next()) {
        (Some(u), None) if (u as u32) <= 0xFFFF && !((c as u32) >= 128 && (u as u32) < 128) => u,
        _ => c,
    }
}

/// The BMP characters that share a `js_canonicalize` value with at least one other, by that value.
static JS_CASE_GROUPS: LazyLock<HashMap<char, Vec<char>>> = LazyLock::new(|| {
    let mut by: HashMap<char, Vec<char>> = HashMap::new();
    for cp in 0..=0xFFFFu32 {
        if let Some(c) = char::from_u32(cp) {
            by.entry(js_canonicalize(c)).or_default().push(c);
        }
    }
    by.retain(|_, v| v.len() > 1);
    by
});

/// The characters a JS `/i` (non-unicode) regex treats as equal to `c`, including `c`.
fn js_case_equivalents(c: char) -> Vec<char> {
    JS_CASE_GROUPS
        .get(&js_canonicalize(c))
        .cloned()
        .unwrap_or_else(|| vec![c])
}

fn class_char(c: char) -> String {
    format!(r"\x{{{:X}}}", c as u32)
}

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

/// A class atom: its code-point ranges, whether it is a single character, and its source length.
type ClassAtom = (Vec<(u32, u32)>, bool, usize);

/// One class atom at `chars[i]` (after `[`): its code-point ranges and its length, or None at `]`.
/// Ranges for class escapes (`\d`, `\W`, ...) are returned with `single = false` (no `a-b` with them).
fn class_atom(chars: &[char], i: usize) -> Result<Option<ClassAtom>, String> {
    let Some(&c) = chars.get(i) else {
        return Err("unterminated character class".into());
    };
    if c == ']' {
        return Ok(None);
    }
    if c != '\\' {
        return Ok(Some((vec![(c as u32, c as u32)], true, 1)));
    }
    let Some(&e) = chars.get(i + 1) else {
        return Err("trailing backslash".into());
    };
    let one = |v: u32, len: usize| Ok(Some((vec![(v, v)], true, len)));
    let set = |r: Vec<(u32, u32)>| Ok(Some((r, false, 2)));
    let word = vec![(0x30, 0x39), (0x41, 0x5A), (0x5F, 0x5F), (0x61, 0x7A)];
    match e {
        'd' => set(vec![(0x30, 0x39)]),
        'D' => set(vec![(0, 0x2F), (0x3A, 0x10FFFF)]),
        'w' => set(word),
        'W' => set(vec![
            (0, 0x2F),
            (0x3A, 0x40),
            (0x5B, 0x5E),
            (0x60, 0x60),
            (0x7B, 0x10FFFF),
        ]),
        's' => set(vec![
            (0x09, 0x0D),
            (0x20, 0x20),
            (0xA0, 0xA0),
            (0x1680, 0x1680),
            (0x2000, 0x200A),
            (0x2028, 0x2029),
            (0x202F, 0x202F),
            (0x205F, 0x205F),
            (0x3000, 0x3000),
            (0xFEFF, 0xFEFF),
        ]),
        'b' => one(8, 2),
        'n' => one(10, 2),
        'r' => one(13, 2),
        't' => one(9, 2),
        'f' => one(12, 2),
        'v' => one(11, 2),
        'u' => match hex_digits(chars, i + 2, 4) {
            Some(h) => one(u32::from_str_radix(&h, 16).unwrap(), 6),
            None => one('u' as u32, 2),
        },
        'x' => match hex_digits(chars, i + 2, 2) {
            Some(h) => one(u32::from_str_radix(&h, 16).unwrap(), 4),
            None => one('x' as u32, 2),
        },
        '0' if !chars.get(i + 2).is_some_and(|d| d.is_ascii_digit()) => one(0, 2),
        other => one(other as u32, 2),
    }
}

/// Whether `out` ends with an unescaped `-` (an even number of backslashes before it).
fn ends_with_bare_dash(out: &str) -> bool {
    let Some(rest) = out.strip_suffix('-') else {
        return false;
    };
    rest.chars().rev().take_while(|&c| c == '\\').count() % 2 == 0
}

/// For a case-insensitive class starting at `chars[start]` (its first member): the characters JS
/// treats as equal to a member but the class doesn't list, as class text to append before `]`.
fn class_case_closure(chars: &[char], start: usize) -> Result<String, String> {
    let mut ranges: Vec<(u32, u32)> = Vec::new();
    let mut i = start;
    while let Some((r, single, len)) = class_atom(chars, i)? {
        i += len;
        // `a-b`: a range between two single characters (not at the end of the class).
        if single && chars.get(i) == Some(&'-') && chars.get(i + 1).is_some_and(|&n| n != ']') {
            if let Some((r2, true, len2)) = class_atom(chars, i + 1)? {
                ranges.push((r[0].0, r2[0].1));
                i += 1 + len2;
                continue;
            }
        }
        ranges.extend(r);
    }
    let has = |c: char| ranges.iter().any(|&(a, b)| (a..=b).contains(&(c as u32)));
    let mut extra: Vec<char> = Vec::new();
    for group in JS_CASE_GROUPS.values() {
        if group.iter().any(|&c| has(c)) {
            extra.extend(group.iter().copied().filter(|&c| !has(c)));
        }
    }
    extra.sort_unstable();
    Ok(extra.into_iter().map(class_char).collect())
}

/// A literal character outside a class: with `i`, the set of its JS equivalents.
fn push_ci_literal(out: &mut String, c: char, ci: bool) {
    let eq = if ci { js_case_equivalents(c) } else { vec![c] };
    if eq.len() > 1 {
        out.push('[');
        for e in eq {
            out.push_str(&class_char(e));
        }
        out.push(']');
    } else {
        push_literal(out, c);
    }
}

/// Translates JS regex source (non-unicode mode) to `fancy-regex` syntax.
pub fn translate(source: &str, flags: &str) -> Result<String, String> {
    let mut out = String::new();
    let mut inline = String::new();
    let ci = flags.contains('i');
    for f in flags.chars() {
        match f {
            // `i` is applied by expansion (JS canonicalize), not by Rust's Unicode case folding.
            'i' => {}
            'm' | 's' => inline.push(f),
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
    let mut class_extra = String::new();
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
                        let ch = char::from_u32(u32::from_str_radix(&h, 16).unwrap());
                        match ch {
                            Some(ch) if ci && !in_class => push_ci_literal(&mut out, ch, ci),
                            _ => out.push_str(&format!(r"\x{{{h}}}")),
                        }
                        i += 4;
                    }
                    None => push_ci_literal(&mut out, 'u', ci && !in_class),
                },
                'x' => match hex_digits(&chars, i + 1, 2) {
                    Some(h) => {
                        let ch = char::from_u32(u32::from_str_radix(&h, 16).unwrap());
                        match ch {
                            Some(ch) if ci && !in_class => push_ci_literal(&mut out, ch, ci),
                            _ => out.push_str(&format!(r"\x{{{h}}}")),
                        }
                        i += 2;
                    }
                    None => push_ci_literal(&mut out, 'x', ci && !in_class),
                },
                '0' if !chars.get(i + 1).is_some_and(|d| d.is_ascii_digit()) => out.push_str(r"\x{0}"),
                '1'..='9' if !in_class => {
                    if ci {
                        return Err("backreferences with the `i` flag are not supported".into());
                    }
                    out.push('\\');
                    out.push(e);
                    while chars.get(i + 1).is_some_and(|d| d.is_ascii_digit()) {
                        i += 1;
                        out.push(chars[i]);
                    }
                }
                'c' | 'k' | 'p' | 'P' => return Err(format!(r"\{e} is not supported")),
                // Identity escapes: `\-`, `\.`, `\/`, `\–`, `\：` ... are the literal character.
                other => push_ci_literal(&mut out, other, ci && !in_class),
            }
            i += 1;
            continue;
        }

        if in_class {
            match c {
                ']' => {
                    in_class = false;
                    if !class_extra.is_empty() && ends_with_bare_dash(&out) {
                        // JS reads a final `-` as a literal; the appended members would make it a range.
                        out.pop();
                        out.push_str(r"\-");
                    }
                    out.push_str(&std::mem::take(&mut class_extra));
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
                if ci {
                    class_extra = class_case_closure(&chars, i + 1)?;
                }
            }
            '.' => out.push_str(r"[^\n\r\x{2028}\x{2029}]"),
            '(' if chars.get(i + 1) == Some(&'?')
                && chars.get(i + 2) == Some(&'<')
                && !matches!(chars.get(i + 3), Some('=') | Some('!')) =>
            {
                out.push_str("(?P<");
                i += 3;
                // The group name is copied verbatim: it isn't matched text, so `i` mustn't expand it.
                while let Some(&n) = chars.get(i) {
                    out.push(n);
                    i += 1;
                    if n == '>' {
                        break;
                    }
                }
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
            // Syntax characters (`( ) | * + ? ^ $`) have no case equivalents, so they pass unchanged.
            _ if ci && js_case_equivalents(c).len() > 1 => push_ci_literal(&mut out, c, true),
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

    /// JS `/i` without `u` folds by `Canonicalize` (single-unit uppercase, never non-ASCII onto
    /// ASCII), not by Unicode case folding. Found by the reviewer on #136 (the ` EſT` example).
    #[test]
    fn case_insensitive_is_js_canonicalize() {
        let abbr = JsRegex::new(r"^\s*([A-Z]{2,4})(?:\W|$)", "i");
        assert_eq!(
            abbr.exec(" EsT").and_then(|m| m.get(1).map(str::to_string)),
            Some("EsT".into())
        );
        assert!(!abbr.is_match(" E\u{17F}T"), "U+017F LONG S is not `s` in JS");
        let k = JsRegex::new("k", "i");
        assert!(k.is_match("K") && k.is_match("k"));
        assert!(!k.is_match("\u{212A}"), "U+212A KELVIN SIGN is not `k` in JS");
        assert!(!JsRegex::new("[a-z]", "i").is_match("\u{212A}"));
        assert!(!JsRegex::new("[a-z]", "i").is_match("\u{17F}"));
        // Real case pairs still fold, inside and outside classes.
        assert!(JsRegex::new("é", "i").is_match("É") && JsRegex::new("[à-ÿ]", "i").is_match("É"));
        let sigma = JsRegex::new("σ", "i");
        assert!(sigma.is_match("Σ") && sigma.is_match("ς"));
        // Full mappings don't count: ß is not SS.
        assert!(!JsRegex::new("^ß$", "i").is_match("SS") && !JsRegex::new("^s$", "i").is_match("ß"));
        // Negated classes are closed before negation.
        let not_lower = JsRegex::new("^[^a-z]$", "i");
        assert!(!not_lower.is_match("A") && not_lower.is_match("\u{17F}") && not_lower.is_match("\u{212A}"));
        // Escapes fold like literals: \x41 is `A`; \u017F stays itself.
        assert!(JsRegex::new(r"^\x41$", "i").is_match("a"));
        assert!(!JsRegex::new(r"^\u017F$", "i").is_match("s"));
        // Astral characters are surrogate pairs in JS: they never fold without `u`.
        assert!(!JsRegex::new("\u{10400}", "i").is_match("\u{10428}"));
        // Without `i`, nothing changes.
        assert!(!JsRegex::new("k", "").is_match("K"));
    }

    #[test]
    fn case_insensitive_class_keeps_a_final_dash_literal() {
        // Appended case equivalents must not turn a final `-` into a range (`[k-\x{4B}]`, `[A-\x{61}]`).
        let k = JsRegex::new("^[k-]$", "i");
        assert!(k.is_match("K") && k.is_match("-"));
        let a = JsRegex::new("^[A-]$", "i");
        assert!(a.is_match("a") && a.is_match("-") && !a.is_match("_"));
        let x = JsRegex::new("^[x-]$", "i");
        assert!(x.is_match("X"));
        let lead = JsRegex::new("^[-a]$", "i");
        assert!(lead.is_match("A") && !lead.is_match("_"));
        assert!(JsRegex::new(r"^[a\-]$", "i").is_match("A"));
    }

    #[test]
    fn case_insensitive_group_names_are_not_expanded() {
        let re = JsRegex::new("(?<ab>.)(?<AB>.)", "i");
        assert!(re.is_match("xy"));
    }

    #[test]
    fn case_insensitive_backreferences_are_rejected() {
        assert!(JsRegex::try_new(r"(a)\1", "i").is_err());
        assert!(JsRegex::try_new(r"(a)\1", "").is_ok());
    }

    #[test]
    fn js_canonicalize_rules() {
        assert_eq!(js_canonicalize('a'), 'A');
        assert_eq!(js_canonicalize('\u{17F}'), '\u{17F}', "non-ASCII never maps onto ASCII");
        assert_eq!(
            js_canonicalize('\u{131}'),
            '\u{131}',
            "dotless i: its uppercase I is ASCII"
        );
        assert_eq!(js_canonicalize('ß'), 'ß', "uppercase is two units (SS)");
        assert_eq!(js_canonicalize('ς'), 'Σ');
    }
}
