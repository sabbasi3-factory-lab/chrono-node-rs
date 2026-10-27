//! The Rust configurations must list the same parsers and refiners, in the same order and with
//! the same constructor flags, as chrono-node (recorded in `tests/golden/configurations.json`).

use std::fs;
use std::path::Path;

use chrono_node::core::configuration::{Configuration, Slot};
use chrono_node::locales::en::configuration::{create_casual_configuration, create_configuration};
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

#[test]
fn english_configurations_match_upstream() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/configurations.json");
    let data: Value = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
    let configs: [(&str, Configuration); 4] = [
        ("en.casual", create_casual_configuration(false)),
        ("en.strict", create_configuration(true, false)),
        ("en.GB.casual", create_casual_configuration(true)),
        ("en.GB.strict", create_configuration(true, true)),
    ];
    for (name, rust) in configs {
        let upstream = &data["configurations"][name];
        assert!(upstream.is_object(), "{name} missing from configurations.json");
        check_slots(name, "parsers", &rust.parsers, &upstream["parsers"]);
        check_slots(name, "refiners", &rust.refiners, &upstream["refiners"]);
    }
}

/// Factory drill parsers (`src/locales/en/parsers/factory_drill_*.rs`, tiers.yaml
/// `promote_tasks_paths`) are compiled but never reachable: no configuration names them, so a
/// merged drill can't change what chrono parses. `build.rs` makes every such file declare a
/// `FactoryDrill…` upstream name, and the order test above pins each list to chrono-node's.
#[test]
fn factory_drill_parsers_are_never_configured() {
    let configs = [
        create_casual_configuration(false),
        create_configuration(true, false),
        create_casual_configuration(true),
        create_configuration(true, true),
        create_configuration(false, false),
        create_configuration(false, true),
    ];
    for config in &configs {
        for slot in config.parsers.iter().chain(config.refiners.iter()) {
            assert!(
                !slot.name.starts_with("FactoryDrill"),
                "a factory drill step is configured: {}",
                slot.name
            );
        }
    }
}
