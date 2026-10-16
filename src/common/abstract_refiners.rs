//! upstream `common/abstractRefiners.ts`: `Filter` and `MergingRefiner`.
//!
//! Implement [`FilterRefiner`] and wrap it in [`Filtering`], or implement [`MergingRefiner`] and
//! wrap it in [`Merging`]: `Box::new(Merging::new(MyRefiner))`.

use crate::core::chrono::Refiner;
use crate::core::context::ParsingContext;
use crate::core::result::ParsingResult;

/// upstream `Filter`: keeps the results for which `is_valid` is true.
pub trait FilterRefiner: Send + Sync {
    fn is_valid(&self, context: &ParsingContext, result: &ParsingResult) -> bool;
}

pub struct Filtering<F>(pub F);

impl<F: FilterRefiner> Filtering<F> {
    pub fn new(inner: F) -> Filtering<F> {
        Filtering(inner)
    }
}

impl<F: FilterRefiner> Refiner for Filtering<F> {
    fn refine(&self, context: &ParsingContext, results: Vec<ParsingResult>) -> Vec<ParsingResult> {
        results.into_iter().filter(|r| self.0.is_valid(context, r)).collect()
    }
}

/// upstream `MergingRefiner`: merges consecutive results.
pub trait MergingRefiner: Send + Sync {
    fn should_merge_results(
        &self,
        text_between: &str,
        current: &ParsingResult,
        next: &ParsingResult,
        context: &ParsingContext,
    ) -> bool;

    /// Takes both results by value: upstream may mutate them while merging.
    fn merge_results(
        &self,
        text_between: &str,
        current: ParsingResult,
        next: ParsingResult,
        context: &ParsingContext,
    ) -> ParsingResult;
}

pub struct Merging<M>(pub M);

impl<M: MergingRefiner> Merging<M> {
    pub fn new(inner: M) -> Merging<M> {
        Merging(inner)
    }
}

fn floor_char_boundary(text: &str, i: usize) -> usize {
    let mut i = i.min(text.len());
    while !text.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// JS `text.substring(start, end)` on byte offsets: arguments are swapped if reversed.
pub fn js_substring(text: &str, start: usize, end: usize) -> &str {
    let (a, b) = if start <= end { (start, end) } else { (end, start) };
    &text[floor_char_boundary(text, a)..floor_char_boundary(text, b)]
}

impl<M: MergingRefiner> Refiner for Merging<M> {
    fn refine(&self, context: &ParsingContext, results: Vec<ParsingResult>) -> Vec<ParsingResult> {
        if results.len() < 2 {
            return results;
        }
        let mut merged = Vec::new();
        let mut iter = results.into_iter();
        let mut current = iter.next().expect("at least two results");
        for next in iter {
            let text_between = js_substring(&context.text, current.index + current.text.len(), next.index).to_string();
            if !self.0.should_merge_results(&text_between, &current, &next, context) {
                merged.push(current);
                current = next;
            } else {
                current = self.0.merge_results(&text_between, current, next, context);
            }
        }
        merged.push(current);
        merged
    }
}
