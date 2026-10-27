//! upstream `common/refiners/OverlapRemovalRefiner.ts`.

use crate::core::chrono::Refiner;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::result::ParsingResult;
use crate::core::utils::pattern::js_len;

pub const UPSTREAM: &str = "OverlapRemovalRefiner";

pub fn create(_flags: &Flags) -> Box<dyn Refiner> {
    Box::new(OverlapRemovalRefiner)
}

/// upstream `OverlapRemovalRefiner`.
pub struct OverlapRemovalRefiner;

impl Refiner for OverlapRemovalRefiner {
    fn refine(&self, _context: &ParsingContext, results: Vec<ParsingResult>) -> Vec<ParsingResult> {
        if results.len() < 2 {
            return results;
        }

        let mut filtered = Vec::new();
        let mut iter = results.into_iter();
        let mut prev = iter.next().unwrap();
        for result in iter {
            if result.index >= prev.index + prev.text.len() {
                filtered.push(prev);
                prev = result;
                continue;
            }

            // If overlap, compare the length and discard the shorter one
            if js_len(&result.text) > js_len(&prev.text) {
                prev = result;
            }
        }

        filtered.push(prev);
        filtered
    }
}
