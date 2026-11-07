//! upstream `locales/ar/parsers/AbstractParserWithWordBoundaryChecking.ts`.
//!
//! A step implements [`WordBoundaryParser`] with `inner_pattern` calling
//! [`left_boundary_inner_pattern`] (upstream `AbstractParserWithLeftBoundaryChecking`) or
//! [`left_right_boundary_inner_pattern`] (`AbstractParserWithLeftRightBoundaryChecking`), and
//! `pattern_left_boundary` returning [`pattern_left_boundary`].

use super::constants::REGEX_PARTS;
use crate::core::regex::JsRegex;

/// `patternLeftBoundary()`.
pub fn pattern_left_boundary() -> &'static str {
    REGEX_PARTS.left_boundary
}

/// `AbstractParserWithLeftBoundaryChecking.innerPattern`: `new RegExp(innerPatternString, flags)`.
pub fn left_boundary_inner_pattern(inner_pattern_string: &str) -> JsRegex {
    JsRegex::new(inner_pattern_string, REGEX_PARTS.flags)
}

/// `AbstractParserWithLeftRightBoundaryChecking.innerPattern`: the inner pattern followed by
/// the right boundary.
pub fn left_right_boundary_inner_pattern(inner_pattern_string: &str) -> JsRegex {
    JsRegex::new(
        &format!("{inner_pattern_string}{}", REGEX_PARTS.right_boundary),
        REGEX_PARTS.flags,
    )
}

/// `innerPatternHasChange`: always false upstream.
pub fn inner_pattern_has_change() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boundaries() {
        assert_eq!(pattern_left_boundary(), r"([^\p{L}\p{N}_]|^)");
        let p = left_right_boundary_inner_pattern("abc");
        assert_eq!(p.source(), r"abc(?=[^\p{L}\p{N}_]|$)");
        assert_eq!(p.flags(), "iu");
        assert_eq!(left_boundary_inner_pattern("abc").source(), "abc");
        assert!(!inner_pattern_has_change());
    }
}
