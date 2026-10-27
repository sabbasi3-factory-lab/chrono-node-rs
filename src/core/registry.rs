//! The auto-generated registry of ported parsers and refiners (see `build.rs`).

use super::chrono::{Parser, Refiner};
use super::configuration::Flags;

/// A registrable parser file: `pub const UPSTREAM` + `pub fn create`.
pub struct ParserEntry {
    pub upstream: &'static str,
    pub create: fn(&Flags) -> Box<dyn Parser>,
}

/// A registrable refiner file: `pub const UPSTREAM` + `pub fn create`.
pub struct RefinerEntry {
    pub upstream: &'static str,
    pub create: fn(&Flags) -> Box<dyn Refiner>,
}

include!(concat!(env!("OUT_DIR"), "/registry/all.rs"));

pub fn find_parser(upstream: &str) -> Option<&'static ParserEntry> {
    all_parsers().into_iter().find(|e| e.upstream == upstream)
}

pub fn find_refiner(upstream: &str) -> Option<&'static RefinerEntry> {
    all_refiners().into_iter().find(|e| e.upstream == upstream)
}

/// Upstream names of every ported parser and refiner.
pub fn ported() -> Vec<&'static str> {
    let mut names: Vec<&'static str> = all_parsers()
        .iter()
        .map(|e| e.upstream)
        .chain(all_refiners().iter().map(|e| e.upstream))
        .collect();
    names.sort_unstable();
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upstream_names_are_unique() {
        let names = ported();
        let mut dedup = names.clone();
        dedup.dedup();
        assert_eq!(names, dedup, "two files claim the same UPSTREAM class");
    }
}
