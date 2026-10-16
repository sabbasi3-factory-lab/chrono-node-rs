//! JSON-lines CLI used by the comparison harness (`harness/compare`).
//!
//! ```sh
//! echo '{"id":1,"text":"next friday","config":"en.casual","reference":{"kind":"date","instant":"2012-08-10T12:00:00.000Z"},"options":{}}' \
//!   | chrono-rs-json
//! chrono-rs-json --registered     # what each configuration can handle
//! ```
//!
//! Each input line is a request in the golden-case shape. Each output line is
//! `{"id": ..., "results": [...]}` or `{"id": ..., "error": "..."}`.

use std::io::{self, BufRead, Write};

use chrono_node::core::json::{parse_request, results_to_json};
use serde_json::{json, Value};

const CONFIGS: [&str; 4] = ["en.casual", "en.strict", "en.GB.casual", "en.GB.strict"];

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--registered") {
        let mut out = serde_json::Map::new();
        for name in CONFIGS {
            let chrono = chrono_node::configuration(name).expect("known configuration");
            out.insert(
                name.to_string(),
                json!({ "registered": chrono.registered(), "missing": chrono.missing }),
            );
        }
        println!("{}", Value::Object(out));
        return;
    }

    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    for line in stdin.lock().lines() {
        let line = line.expect("read stdin");
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<Value>(&line) {
            Err(e) => json!({ "id": Value::Null, "error": format!("bad JSON: {e}") }),
            Ok(v) => {
                let id = v.get("id").cloned().unwrap_or(Value::Null);
                match parse_request(&v) {
                    Err(e) => json!({ "id": id, "error": e }),
                    Ok(req) => match chrono_node::configuration(&req.config) {
                        None => json!({ "id": id, "error": format!("unknown config {}", req.config) }),
                        Some(chrono) => {
                            let results = chrono.parse_with_now(&req.text, &req.reference, &req.option, req.now);
                            json!({ "id": id, "results": results_to_json(&req.text, &results) })
                        }
                    },
                }
            }
        };
        writeln!(stdout, "{response}").expect("write stdout");
    }
}
