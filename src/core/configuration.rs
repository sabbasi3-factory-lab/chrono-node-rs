//! Configurations as ordered **slots** named after upstream classes, resolved through the
//! auto-generated registry (see `build.rs`).
//!
//! A configuration is written once, mirroring upstream's (for example
//! `src/locales/en/configuration.rs` mirrors `ENDefaultConfiguration`). A slot whose step isn't
//! ported yet is skipped and listed in `Chrono::missing`. Porting a parser or refiner means
//! adding one file; the slot already exists.

use std::sync::Arc;

use super::chrono::{Chrono, NamedParser, NamedRefiner, Parser, Refiner};
use super::registry::{find_parser, find_refiner};

/// Upstream constructor arguments, by upstream property name (e.g. `("strictMode", true)`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Flags(Vec<(&'static str, bool)>);

impl Flags {
    pub fn none() -> Flags {
        Flags(Vec::new())
    }

    pub fn of(pairs: &[(&'static str, bool)]) -> Flags {
        Flags(pairs.to_vec())
    }

    /// The flag's value; `false` if it isn't set.
    pub fn get(&self, name: &str) -> bool {
        self.0.iter().find(|(k, _)| *k == name).is_some_and(|(_, v)| *v)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&'static str, bool)> + '_ {
        self.0.iter().copied()
    }
}

/// One position in a configuration's parser or refiner list.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Slot {
    pub name: &'static str,
    pub flags: Flags,
}

/// upstream `Configuration`, as slots.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Configuration {
    pub parsers: Vec<Slot>,
    pub refiners: Vec<Slot>,
}

impl Configuration {
    pub fn push_parser(&mut self, name: &'static str, flags: Flags) {
        self.parsers.push(Slot { name, flags });
    }
    pub fn unshift_parser(&mut self, name: &'static str, flags: Flags) {
        self.parsers.insert(0, Slot { name, flags });
    }
    pub fn push_refiner(&mut self, name: &'static str, flags: Flags) {
        self.refiners.push(Slot { name, flags });
    }
    pub fn unshift_refiner(&mut self, name: &'static str, flags: Flags) {
        self.refiners.insert(0, Slot { name, flags });
    }

    /// `new Chrono(configuration)`: instantiates every ported step, skipping the rest.
    pub fn build(&self) -> Chrono {
        let mut chrono = Chrono::default();
        for slot in &self.parsers {
            match find_parser(slot.name) {
                Some(entry) => {
                    let parser: Arc<dyn Parser> = Arc::from((entry.create)(&slot.flags));
                    chrono.parsers.push(NamedParser {
                        name: slot.name,
                        flags: slot.flags.clone(),
                        parser,
                    });
                }
                None => chrono.missing.push(slot.name),
            }
        }
        for slot in &self.refiners {
            match find_refiner(slot.name) {
                Some(entry) => {
                    let refiner: Arc<dyn Refiner> = Arc::from((entry.create)(&slot.flags));
                    chrono.refiners.push(NamedRefiner {
                        name: slot.name,
                        flags: slot.flags.clone(),
                        refiner,
                    });
                }
                None => chrono.missing.push(slot.name),
            }
        }
        chrono
    }
}
