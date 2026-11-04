//! The Rust configurations must list the same parsers and refiners, in the same order and with
//! the same constructor flags, as chrono-node (recorded in `tests/golden/configurations.json`).

use std::fs;
use std::path::Path;

use chrono_node::core::configuration::{Configuration, Slot};
use chrono_node::locales::{de, en, es, fr, ja, pt, sv};
use serde_json::Value;

fn check_slots(config: &str, kind: &str, rust: &[Slot], upstream: &Value) {
    let upstream = upstream.as_array().unwrap();
    let rust_names: Vec<&str> = rust.iter().map(|s| s.name).collect();
    let upstream_names: Vec<&str> = upstream.iter().map(|s| s["name"].as_str().unwrap()).collect();
    assert_eq!(
        rust_names, upstream_names,
        "{config} {kind}: order differs from upstream"
    );
    for (slot, up) in rust.iter().zip(upstream) {
        for (flag, value) in up["flags"].as_object().unwrap() {
            let value = value.as_bool().unwrap();
            let rust_value = slot.flags.iter().find(|(k, _)| k == flag).map(|(_, v)| v);
            assert_eq!(rust_value, Some(value), "{config} {kind} {}: flag {flag}", slot.name);
        }
    }
}

fn check(configs: Vec<(&str, Configuration)>) {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/configurations.json");
    let data: Value = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
    for (name, rust) in configs {
        let upstream = &data["configurations"][name];
        assert!(upstream.is_object(), "{name} missing from configurations.json");
        check_slots(name, "parsers", &rust.parsers, &upstream["parsers"]);
        check_slots(name, "refiners", &rust.refiners, &upstream["refiners"]);
    }
}

#[test]
fn english_configurations_match_upstream() {
    check(vec![
        ("en.casual", en::configuration::create_casual_configuration(false)),
        ("en.strict", en::configuration::create_configuration(true, false)),
        ("en.GB.casual", en::configuration::create_casual_configuration(true)),
        ("en.GB.strict", en::configuration::create_configuration(true, true)),
    ]);
}

#[test]
fn german_configurations_match_upstream() {
    check(vec![
        ("de.casual", de::configuration::create_casual_configuration(true)),
        ("de.strict", de::configuration::create_configuration(true, true)),
    ]);
}

#[test]
fn french_configurations_match_upstream() {
    check(vec![
        ("fr.casual", fr::configuration::create_casual_configuration(true)),
        ("fr.strict", fr::configuration::create_configuration(true, true)),
    ]);
}

#[test]
fn swedish_configurations_match_upstream() {
    check(vec![
        ("sv.casual", sv::configuration::create_casual_configuration(true)),
        ("sv.strict", sv::configuration::create_configuration(true, true)),
    ]);
}

#[test]
fn portuguese_configurations_match_upstream() {
    check(vec![
        ("pt.casual", pt::configuration::create_casual_configuration(true)),
        ("pt.strict", pt::configuration::create_configuration(true, true)),
    ]);
}

#[test]
fn spanish_configurations_match_upstream() {
    check(vec![
        ("es.casual", es::configuration::create_casual_configuration(true)),
        ("es.strict", es::configuration::create_configuration(true, true)),
    ]);
}

#[test]
fn japanese_configurations_match_upstream() {
    check(vec![
        ("ja.casual", ja::configuration::create_casual_configuration()),
        ("ja.strict", ja::configuration::create_configuration(true)),
    ]);
}
