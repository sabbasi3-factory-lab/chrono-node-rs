//! upstream `common/parsers/AbstractParserWithWordBoundary.ts`.
//!
//! Implement [`WordBoundaryParser`] and wrap it: `Box::new(WithWordBoundary::new(MyParser))`.

use std::sync::Mutex;

use crate::core::chrono::{Extracted, Parser};
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};

/// upstream `AbstractParserWithWordBoundaryChecking`'s abstract part.
pub trait WordBoundaryParser: Send + Sync {
    /// `innerPattern(context)`.
    fn inner_pattern(&self, context: &ParsingContext) -> JsRegex;

    /// `innerExtract(context, match)`: `m` already has the boundary group removed.
    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted;

    /// `patternLeftBoundary()`.
    fn pattern_left_boundary(&self) -> &str {
        r"(\W|^)"
    }
}

/// The concrete `AbstractParserWithWordBoundaryChecking`: prefixes the left-boundary group and
/// strips it from the match before calling `inner_extract`.
pub struct WithWordBoundary<P> {
    inner: P,
    cache: Mutex<Option<(String, String, JsRegex)>>,
}

impl<P: WordBoundaryParser> WithWordBoundary<P> {
    pub fn new(inner: P) -> WithWordBoundary<P> {
        WithWordBoundary {
            inner,
            cache: Mutex::new(None),
        }
    }
}

impl<P: WordBoundaryParser> Parser for WithWordBoundary<P> {
    fn pattern(&self, context: &ParsingContext) -> JsRegex {
        let inner = self.inner.inner_pattern(context);
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((source, flags, pattern)) = cache.as_ref() {
            if source == inner.source() && flags == inner.flags() {
                return pattern.clone();
            }
        }
        let pattern = JsRegex::new(
            &format!("{}{}", self.inner.pattern_left_boundary(), inner.source()),
            inner.flags(),
        );
        *cache = Some((inner.source().to_string(), inner.flags().to_string(), pattern.clone()));
        pattern
    }

    fn extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let header_len = m.get(1).map_or(0, str::len);
        m.index += header_len;
        if let Some(Some(full)) = m.groups.first_mut() {
            *full = full[header_len..].to_string();
        }
        // Like upstream: shift groups down by one; the last slot keeps its old value.
        for i in 2..m.groups.len() {
            m.groups[i - 1] = m.groups[i].clone();
        }
        self.inner.inner_extract(context, m)
    }
}
