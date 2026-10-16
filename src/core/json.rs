//! The shared JSON shape of requests and results (see `harness/lib/serialize.js` and
//! `tests/golden/README.md`). Used by the golden runner and the `chrono-rs-json` CLI.

use serde_json::{json, Map, Value};

use super::components::{ComponentMap, ParsingComponents};
use super::context::ParsingOption;
use super::js_date::JsDate;
use super::reference::{ParsingReference, ReferenceInput};
use super::result::ParsingResult;
use super::timezone::{TimezoneInput, TimezoneSpec};

/// Byte offset -> JavaScript string index (UTF-16 code units).
pub fn utf16_index(text: &str, byte_index: usize) -> usize {
    text.get(..byte_index).map_or(0, |prefix| prefix.encode_utf16().count())
}

fn component_map_json(map: &ComponentMap) -> Value {
    let mut obj = Map::new();
    for (c, v) in map.iter() {
        obj.insert(c.name().to_string(), json!(v));
    }
    Value::Object(obj)
}

pub fn components_to_json(c: &ParsingComponents) -> Value {
    let mut tags: Vec<&str> = c.tags().iter().map(String::as_str).collect();
    tags.sort_unstable();
    json!({
        "known": component_map_json(c.known_values()),
        "implied": component_map_json(c.implied_values()),
        "date": c.date().to_iso_string(),
        "tags": tags,
    })
}

/// One result; `text` is the full parsed text, to convert `index` to UTF-16.
pub fn result_to_json(text: &str, r: &ParsingResult) -> Value {
    json!({
        "index": utf16_index(text, r.index),
        "text": r.text,
        "start": components_to_json(&r.start),
        "end": r.end.as_ref().map(components_to_json),
    })
}

pub fn results_to_json(text: &str, results: &[ParsingResult]) -> Value {
    Value::Array(results.iter().map(|r| result_to_json(text, r)).collect())
}

/// A parse request in the golden-case / harness shape.
#[derive(Clone, Debug)]
pub struct Request {
    pub text: String,
    pub config: String,
    pub reference: ReferenceInput,
    /// What "now" was when the case was recorded (the resolved reference instant).
    pub now: JsDate,
    pub option: ParsingOption,
}

/// Parses `{text, config, reference, options}`. Unknown option keys are an error (fail closed).
pub fn parse_request(v: &Value) -> Result<Request, String> {
    let text = v.get("text").and_then(Value::as_str).ok_or("missing text")?.to_string();
    let config = v
        .get("config")
        .and_then(Value::as_str)
        .unwrap_or("en.casual")
        .to_string();
    if let Some(tz) = v.get("system_timezone").and_then(Value::as_str) {
        if tz != "UTC" {
            return Err(format!("system_timezone must be UTC, got {tz}"));
        }
    }

    let r = v.get("reference").ok_or("missing reference")?;
    let kind = r.get("kind").and_then(Value::as_str).ok_or("missing reference.kind")?;
    let instant_str = r
        .get("instant")
        .and_then(Value::as_str)
        .ok_or("missing reference.instant")?;
    let instant = JsDate::parse_iso(instant_str).ok_or_else(|| format!("bad instant {instant_str}"))?;
    let timezone = match r.get("timezone_input") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(TimezoneInput::Abbr(s.clone())),
        Some(Value::Number(n)) => Some(TimezoneInput::Minutes(
            n.as_i64().ok_or("timezone_input must be an integer")?,
        )),
        Some(other) => return Err(format!("bad timezone_input {other}")),
    };
    let reference = match kind {
        "none" => ReferenceInput::Now,
        "date" => ReferenceInput::Date(instant),
        "object" => ReferenceInput::Reference(ParsingReference {
            instant: Some(instant),
            timezone,
        }),
        other => return Err(format!("bad reference.kind {other}")),
    };

    let mut option = ParsingOption::default();
    if let Some(opts) = v.get("options").and_then(Value::as_object) {
        for (key, value) in opts {
            match key.as_str() {
                "forwardDate" => option.forward_date = value.as_bool().ok_or("forwardDate must be a boolean")?,
                "timezones" => {
                    for (abbr, offset) in value.as_object().ok_or("timezones must be an object")? {
                        let minutes = offset.as_i64().ok_or("timezone overrides must be integer minutes")?;
                        option.timezones.insert(abbr.clone(), TimezoneSpec::Fixed(minutes));
                    }
                }
                other => return Err(format!("unsupported option {other}")),
            }
        }
    }

    Ok(Request {
        text,
        config,
        reference,
        now: instant,
        option,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_indexes() {
        let text = "😀 é now";
        assert_eq!(utf16_index(text, text.find("now").unwrap()), 5);
    }

    #[test]
    fn request_roundtrip() {
        let req = parse_request(&json!({
            "text": "Friday at 4pm",
            "config": "en.casual",
            "reference": {"kind": "object", "instant": "2021-06-09T12:00:00.000Z", "timezone_input": "CDT", "timezone_offset": -300},
            "system_timezone": "UTC",
            "options": {"forwardDate": true, "timezones": {"XYZ": 60}},
        }))
        .unwrap();
        assert!(req.option.forward_date);
        assert_eq!(req.option.timezones.get("XYZ"), Some(&TimezoneSpec::Fixed(60)));
        assert!(matches!(req.reference, ReferenceInput::Reference(_)));
        assert!(parse_request(&json!({"text": "x", "reference": {"kind": "none", "instant": "2012-08-10T12:00:00.000Z"}, "options": {"debug": true}})).is_err());
    }
}
