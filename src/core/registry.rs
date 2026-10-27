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

/// Whether `name` is a factory drill class (`FactoryDrill…`). Drill step files are never registered
/// (`build.rs`); this is checked at compile time on each one's `UPSTREAM`.
pub const fn is_factory_drill_name(name: &str) -> bool {
    let prefix = b"FactoryDrill";
    let n = name.as_bytes();
    if n.len() < prefix.len() {
        return false;
    }
    let mut i = 0;
    while i < prefix.len() {
        if n[i] != prefix[i] {
            return false;
        }
        i += 1;
    }
    true
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
    fn factory_drill_steps_are_never_registered() {
        assert!(is_factory_drill_name("FactoryDrillX"));
        assert!(!is_factory_drill_name("FactoryDril"));
        assert!(!is_factory_drill_name("ISOFormatParser"));
        assert!(
            ported().iter().all(|n| !is_factory_drill_name(n)),
            "a drill step is registered"
        );
        assert!(find_parser("FactoryDrillRepairOk").is_none());
    }

    #[test]
    fn upstream_names_are_unique() {
        let names = ported();
        let mut dedup = names.clone();
        dedup.dedup();
        assert_eq!(names, dedup, "two files claim the same UPSTREAM class");
    }
}
