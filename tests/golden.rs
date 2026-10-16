//! The whole-crate golden suite: every case in `tests/golden/` whose `requires` are all ported
//! must reproduce chrono-node's output exactly. The rest are reported as pending.
//!
//! ```sh
//! cargo test --test golden -- --nocapture                  # summary per area
//! GOLDEN_AREAS=en/weekday,en/casual cargo test --test golden # only these areas
//! GOLDEN_REQUIRE_ALL=1 ...                                  # pending cases fail too (contract acceptance)
//! ```

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use chrono_node::core::json::{parse_request, results_to_json};
use serde_json::Value;

fn golden_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden")
}

fn area_files() -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    for group in ["core", "en"] {
        let Ok(entries) = fs::read_dir(golden_dir().join(group)) else {
            continue;
        };
        for e in entries.flatten() {
            let path = e.path();
            if path.extension().and_then(|x| x.to_str()) == Some("json") {
                let stem = path.file_stem().unwrap().to_string_lossy().to_string();
                out.push((format!("{group}/{stem}"), path));
            }
        }
    }
    out.sort();
    out
}

#[derive(Default)]
struct Tally {
    checked: usize,
    pending: usize,
    failed: usize,
}

#[test]
fn golden_suite() {
    let filter: Option<Vec<String>> = std::env::var("GOLDEN_AREAS")
        .ok()
        .map(|v| v.split(',').map(|s| s.trim().to_string()).collect());
    let require_all = std::env::var("GOLDEN_REQUIRE_ALL").is_ok_and(|v| v == "1");

    let files = area_files();
    assert!(
        !files.is_empty(),
        "no golden files under tests/golden (run harness/golden/generate.js)"
    );
    // A misspelled or empty area list must not pass by checking nothing.
    if let Some(wanted) = &filter {
        let known: Vec<&str> = files.iter().map(|(a, _)| a.as_str()).collect();
        assert!(wanted.iter().all(|w| !w.is_empty()), "GOLDEN_AREAS has an empty entry");
        let unknown: Vec<&String> = wanted.iter().filter(|w| !known.contains(&w.as_str())).collect();
        assert!(unknown.is_empty(), "unknown GOLDEN_AREAS: {unknown:?}");
    }

    let mut tallies: BTreeMap<String, Tally> = BTreeMap::new();
    let mut failures: Vec<String> = Vec::new();

    for (area, path) in files {
        if filter.as_ref().is_some_and(|f| !f.contains(&area)) {
            continue;
        }
        let data: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(data["schema"], 1, "{area}: unknown golden schema");
        let tally = tallies.entry(area.clone()).or_default();

        for case in data["cases"].as_array().unwrap() {
            let id = case["id"].as_str().unwrap_or("?");
            let req = parse_request(case).unwrap_or_else(|e| panic!("{id}: {e}"));
            let chrono = chrono_node::configuration(&req.config)
                .unwrap_or_else(|| panic!("{id}: unknown config {}", req.config));
            let registered = chrono.registered();
            let requires: Vec<&str> = ["parsers", "refiners"]
                .iter()
                .flat_map(|k| {
                    case["requires"][k]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|v| v.as_str().unwrap())
                })
                .collect();
            if !requires.iter().all(|r| registered.contains(r)) {
                tally.pending += 1;
                if require_all {
                    failures.push(format!("{id}: pending (needs {requires:?})"));
                }
                continue;
            }
            tally.checked += 1;
            let results = chrono.parse_with_now(&req.text, &req.reference, &req.option, req.now);
            let actual = results_to_json(&req.text, &results);
            if actual != case["results"] {
                tally.failed += 1;
                failures.push(format!(
                    "{id} {:?} ({}):\n  expected {}\n  actual   {}",
                    req.text, req.config, case["results"], actual
                ));
            }
        }
    }

    let (mut checked, mut pending, mut failed) = (0, 0, 0);
    println!("{:<32} {:>8} {:>8} {:>8}", "area", "checked", "pending", "failed");
    for (area, t) in &tallies {
        println!("{area:<32} {:>8} {:>8} {:>8}", t.checked, t.pending, t.failed);
        checked += t.checked;
        pending += t.pending;
        failed += t.failed;
    }
    println!("{:<32} {checked:>8} {pending:>8} {failed:>8}", "TOTAL");

    if !failures.is_empty() {
        for f in failures.iter().take(25) {
            eprintln!("{f}");
        }
        panic!("{} golden case(s) failed", failures.len());
    }
}
