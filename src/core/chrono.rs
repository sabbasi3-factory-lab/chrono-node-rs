//! upstream `chrono.ts`: the `Parser` and `Refiner` abstractions and the parse loop.

use std::collections::BTreeSet;
use std::sync::Arc;

use super::components::{Component, ParsingComponents};
use super::configuration::Flags;
use super::context::{ParsingContext, ParsingOption};
use super::js_date::JsDate;
use super::reference::ReferenceInput;
use super::regex::{JsRegex, RegexMatch};
use super::result::ParsingResult;

/// What `Parser::extract` returns (upstream returns one of these types, or `null`).
#[derive(Clone, Debug)]
pub enum Extracted {
    /// `null`: no result here; chrono retries one character after `m.index`.
    None,
    Components(ParsingComponents),
    Result(ParsingResult),
    /// A plain `{ [component]: number }` object of known values.
    Known(Vec<(Component, i64)>),
}

/// upstream `Parser`.
pub trait Parser: Send + Sync {
    /// `pattern(context)`. Return a clone of a cached regex; cloning is cheap.
    fn pattern(&self, context: &ParsingContext) -> JsRegex;

    /// `extract(context, match)`. `m.index` is the byte offset of the match in `context.text`.
    /// Like upstream, an extractor may move `m.index` before returning `Extracted::None` to
    /// control where the search resumes.
    fn extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted;
}

/// upstream `Refiner`.
pub trait Refiner: Send + Sync {
    fn refine(&self, context: &ParsingContext, results: Vec<ParsingResult>) -> Vec<ParsingResult>;
}

/// A parser in a configuration slot, with the upstream class name and constructor flags.
#[derive(Clone)]
pub struct NamedParser {
    pub name: &'static str,
    pub flags: Flags,
    pub parser: Arc<dyn Parser>,
}

#[derive(Clone)]
pub struct NamedRefiner {
    pub name: &'static str,
    pub flags: Flags,
    pub refiner: Arc<dyn Refiner>,
}

/// upstream `Chrono`: an ordered list of parsers and refiners.
#[derive(Clone, Default)]
pub struct Chrono {
    pub parsers: Vec<NamedParser>,
    pub refiners: Vec<NamedRefiner>,
    /// Slots in the configuration whose step isn't ported yet. They are skipped.
    pub missing: Vec<&'static str>,
}

impl Chrono {
    /// `parse(text, ref, option)`, with "now" taken from the system clock.
    pub fn parse(&self, text: &str, reference: &ReferenceInput, option: &ParsingOption) -> Vec<ParsingResult> {
        self.parse_with_now(text, reference, option, JsDate::now())
    }

    /// `parse` with an explicit "now" (used when the reference is `Now`), for reproducible runs.
    pub fn parse_with_now(
        &self,
        text: &str,
        reference: &ReferenceInput,
        option: &ParsingOption,
        now: JsDate,
    ) -> Vec<ParsingResult> {
        let context = ParsingContext::new(text, reference, option.clone(), now);
        let mut results = Vec::new();
        for p in &self.parsers {
            results.extend(execute_parser(&context, p.parser.as_ref()));
        }
        // Stable sort, like JS Array.prototype.sort.
        results.sort_by_key(|r| r.index);
        for r in &self.refiners {
            results = r.refiner.refine(&context, results);
        }
        results
    }

    /// `parseDate(text, ref, option)`.
    pub fn parse_date(&self, text: &str, reference: &ReferenceInput, option: &ParsingOption) -> Option<JsDate> {
        self.parse(text, reference, option).first().map(|r| r.start.date())
    }

    /// Upstream class names of the parsers and refiners actually present.
    pub fn registered(&self) -> BTreeSet<&'static str> {
        self.parsers
            .iter()
            .map(|p| p.name)
            .chain(self.refiners.iter().map(|r| r.name))
            .collect()
    }
}

fn char_boundary_at_or_after(text: &str, i: usize) -> usize {
    let mut i = i.min(text.len());
    while !text.is_char_boundary(i) {
        i += 1;
    }
    i
}

/// upstream `Chrono.executeParser`. Like upstream, each search runs on the **remaining
/// substring**, so `^` and lookbehinds see the slice start, not the full text.
pub fn execute_parser(context: &ParsingContext, parser: &dyn Parser) -> Vec<ParsingResult> {
    let mut results = Vec::new();
    let pattern = parser.pattern(context);
    let text = context.text.as_str();
    let mut offset = 0;
    let mut found = pattern.exec(text);

    while let Some(mut m) = found {
        m.index += offset;
        let parsed = match parser.extract(context, &mut m) {
            Extracted::None => {
                // `originalText.substring(match.index + 1)`
                let next = m.index + 1;
                if next > text.len() {
                    break;
                }
                offset = char_boundary_at_or_after(text, next);
                found = pattern.exec(&text[offset..]);
                continue;
            }
            Extracted::Result(r) => r,
            Extracted::Components(c) => {
                let mut r = context.create_parsing_result(m.index, m.text(), None, None);
                r.start = c;
                r
            }
            Extracted::Known(known) => {
                let start = context.create_parsing_components(&known);
                context.create_parsing_result(m.index, m.text(), Some(start), None)
            }
        };
        offset = char_boundary_at_or_after(text, parsed.index + parsed.text.len());
        results.push(parsed);
        found = pattern.exec(&text[offset..]);
    }
    results
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::components::Component;

    /// Matches `^?(\d+)`; accepts even numbers; odd numbers jump past themselves.
    struct EvenNumbers {
        anchored: bool,
        skip_whole_match: bool,
    }

    impl Parser for EvenNumbers {
        fn pattern(&self, _: &ParsingContext) -> JsRegex {
            JsRegex::new(if self.anchored { r"^\s*(\d+)" } else { r"(\d+)" }, "")
        }
        fn extract(&self, _: &ParsingContext, m: &mut RegexMatch) -> Extracted {
            let n: i64 = m.get(1).unwrap().parse().unwrap();
            if n % 2 == 1 {
                if self.skip_whole_match {
                    m.index += m.text().len();
                }
                return Extracted::None;
            }
            Extracted::Known(vec![(Component::Day, n)])
        }
    }

    fn run(p: EvenNumbers, text: &str) -> Vec<(usize, String)> {
        let context = ParsingContext::new(
            text,
            &ReferenceInput::Date(JsDate::from_millis(0)),
            ParsingOption::default(),
            JsDate::INVALID,
        );
        execute_parser(&context, &p)
            .into_iter()
            .map(|r| (r.index, r.text))
            .collect()
    }

    // Expected outputs below were computed by running the same toy parser through upstream's
    // `executeParser` loop in Node.

    #[test]
    fn retries_one_char_after_a_rejected_match() {
        let out = run(
            EvenNumbers {
                anchored: false,
                skip_whole_match: false,
            },
            "13 24 6",
        );
        assert_eq!(out, vec![(3, "24".into()), (6, "6".into())]);
        let out = run(
            EvenNumbers {
                anchored: false,
                skip_whole_match: false,
            },
            "14x",
        );
        assert_eq!(out, vec![(0, "14".into())]);
        let out = run(
            EvenNumbers {
                anchored: false,
                skip_whole_match: false,
            },
            "35x",
        );
        assert_eq!(out, vec![]);
    }

    #[test]
    fn extractor_can_move_the_retry_point() {
        let out = run(
            EvenNumbers {
                anchored: false,
                skip_whole_match: true,
            },
            "35x",
        );
        assert_eq!(out, vec![]);
        let out = run(
            EvenNumbers {
                anchored: false,
                skip_whole_match: true,
            },
            "3 4x",
        );
        assert_eq!(out, vec![(2, "4".into())]);
    }

    #[test]
    fn caret_anchors_at_the_remaining_slice() {
        // After "2" is consumed, the search restarts on " 4 x 6", so ^ matches again there.
        let out = run(
            EvenNumbers {
                anchored: true,
                skip_whole_match: false,
            },
            "2 4 x 6",
        );
        assert_eq!(out, vec![(0, "2".into()), (1, " 4".into())]);
    }

    #[test]
    fn multibyte_text_keeps_byte_indexes_on_char_boundaries() {
        let out = run(
            EvenNumbers {
                anchored: false,
                skip_whole_match: false,
            },
            "é1é2",
        );
        assert_eq!(out, vec![(5, "2".into())]);
    }

    #[test]
    fn empty_configuration_finds_nothing() {
        let c = Chrono::default();
        assert!(c
            .parse("tomorrow", &ReferenceInput::Now, &ParsingOption::default())
            .is_empty());
    }
}
