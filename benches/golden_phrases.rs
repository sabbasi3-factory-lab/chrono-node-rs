//! Strict gate `perf_regression_max_pct` (tiers.yaml): parse every golden phrase with the casual
//! English configuration at its reference date. `harness/strict/perf.sh` compares this bench on
//! the change against the same bench on its base.

use std::fs;
use std::path::PathBuf;

use chrono_node::{parse, JsDate, ReferenceInput};
use criterion::{criterion_group, criterion_main, Criterion};
use serde_json::Value;

fn phrases() -> Vec<(String, ReferenceInput)> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/golden/en");
    let mut files: Vec<PathBuf> = fs::read_dir(&root)
        .expect("tests/golden/en")
        .map(|e| e.expect("entry").path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    files.sort();
    let mut out = Vec::new();
    for path in files {
        let data: Value = serde_json::from_str(&fs::read_to_string(&path).expect("golden file")).expect("golden json");
        for case in data["cases"].as_array().into_iter().flatten() {
            let (Some(text), Some(instant)) = (case["text"].as_str(), case["reference"]["instant"].as_str()) else {
                continue;
            };
            let Some(date) = JsDate::parse_iso(instant) else {
                continue;
            };
            out.push((text.to_string(), ReferenceInput::Date(date)));
        }
    }
    assert!(!out.is_empty(), "no golden phrases found");
    out
}

/// Drill D8c (drills/README.md, removed with the drills): when the D8c drill file exists, the bench
/// does every iteration twice, so a PR adding it is measured about 100% slower than its base. It can
/// only make a change look slower: `harness/strict/perf.sh` refuses a base that has the file.
fn drill_rounds() -> usize {
    let marker = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/locales/en/parsers/factory_drill_gate_perf.rs");
    if marker.exists() {
        2
    } else {
        1
    }
}

fn golden_phrases(c: &mut Criterion) {
    let cases = phrases();
    let rounds = drill_rounds();
    c.bench_function("golden_phrases", |b| {
        b.iter(|| {
            let mut n = 0usize;
            for _ in 0..rounds {
                for (text, reference) in &cases {
                    n += parse(std::hint::black_box(text), reference).len();
                }
            }
            n
        })
    });
}

criterion_group!(benches, golden_phrases);
criterion_main!(benches);
