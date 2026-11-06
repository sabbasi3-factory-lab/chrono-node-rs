//! JSON-lines CLI used by the comparison harness (`harness/compare`).
//!
//! ```sh
//! echo '{"id":1,"text":"next friday","config":"en.casual","reference":{"kind":"date","instant":"2012-08-10T12:00:00.000Z"},"options":{}}' \
//!   | chrono-rs-json
//! chrono-rs-json --registered     # what each configuration can handle
//! chrono-rs-json --trace          # per request, each step's output too (harness/golden/frontier.js);
//!                                 # `"isolate": [{step, occurrence, input}]` also runs those refiners
//!                                 # alone on the given input (chrono-node's, for that slot)
//! ```
//!
//! Each input line is a request in the golden-case shape. Each output line is
//! `{"id": ..., "results": [...]}` or `{"id": ..., "error": "..."}`.

use std::io::{self, BufRead, Write};

use chrono_node::core::context::ParsingContext;
use chrono_node::core::json::{parse_request, result_from_json, results_to_json};
use serde_json::{json, Value};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--registered") {
        let mut out = serde_json::Map::new();
        for name in chrono_node::configuration_names() {
            let chrono = chrono_node::configuration(name).expect("known configuration");
            out.insert(
                name.to_string(),
                json!({ "registered": chrono.registered(), "missing": chrono.missing }),
            );
        }
        println!("{}", Value::Object(out));
        return;
    }

    let trace = args.iter().any(|a| a == "--trace");
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
                        Some(chrono) if trace => {
                            let (parsers, refiners) =
                                chrono.trace_with_now(&req.text, &req.reference, &req.option, req.now);
                            let steps = |list: Vec<(&str, Vec<_>)>| {
                                list.into_iter()
                                    .map(|(step, r)| json!({ "step": step, "results": results_to_json(&req.text, &r) }))
                                    .collect::<Vec<_>>()
                            };
                            let results = refiners.last().map(|(_, r)| r.clone());
                            let results = match results {
                                Some(r) => r,
                                None => chrono.parse_with_now(&req.text, &req.reference, &req.option, req.now),
                            };
                            let isolated = isolate(chrono, &req, v.get("isolate"));
                            json!({
                                "id": id,
                                "results": results_to_json(&req.text, &results),
                                "parsers": steps(parsers),
                                "refiners": steps(refiners),
                                "isolated": isolated,
                                "missing": chrono.missing,
                            })
                        }
                        Some(chrono) => {
                            let results = chrono.parse_with_now(&req.text, &req.reference, &req.option, req.now);
                            json!({ "id": id, "results": results_to_json(&req.text, &results) })
                        }
                    },
                }
            }
        };
        writeln!(stdout, "{response}").expect("write stdout");
        // One response per request, immediately: clients may keep stdin open between requests.
        stdout.flush().expect("flush stdout");
    }
}

/// Each `{step, occurrence, input}` run alone: `{step, occurrence, results}`, or `error` (the
/// refiner isn't ported, or the input doesn't parse).
fn isolate(chrono: &chrono_node::Chrono, req: &chrono_node::core::json::Request, list: Option<&Value>) -> Value {
    let context = ParsingContext::new(&req.text, &req.reference, req.option.clone(), req.now);
    let one = |item: &Value| -> Result<Value, String> {
        let step = item.get("step").and_then(Value::as_str).ok_or("missing step")?;
        let occurrence = item.get("occurrence").and_then(Value::as_u64).unwrap_or(0) as usize;
        let input = item
            .get("input")
            .and_then(Value::as_array)
            .ok_or("missing input")?
            .iter()
            .map(|r| result_from_json(&req.text, context.reference, r))
            .collect::<Result<Vec<_>, _>>()?;
        let results = chrono
            .refine_isolated(&context, step, occurrence, input)
            .ok_or_else(|| format!("{step} isn't ported"))?;
        Ok(results_to_json(&req.text, &results))
    };
    let out = list.and_then(Value::as_array).map_or_else(Vec::new, |items| {
        items
            .iter()
            .map(|item| {
                let mut o = json!({ "step": item.get("step"), "occurrence": item.get("occurrence") });
                match one(item) {
                    Ok(r) => o["results"] = r,
                    Err(e) => o["error"] = json!(e),
                }
                o
            })
            .collect()
    });
    Value::Array(out)
}
