//! upstream `common/refiners/ExtractTimezoneAbbrRefiner.ts`.

use crate::core::chrono::Refiner;
use crate::core::components::Component;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::result::ParsingResult;
use crate::core::timezone::{to_timezone_offset, TimezoneAbbrMap, TimezoneInput};
use crate::js_regex;

pub const UPSTREAM: &str = "ExtractTimezoneAbbrRefiner";

pub fn create(_flags: &Flags) -> Box<dyn Refiner> {
    Box::new(ExtractTimezoneAbbrRefiner::new(None))
}

/// upstream `ExtractTimezoneAbbrRefiner`; `timezone_overrides` is the optional constructor map.
pub struct ExtractTimezoneAbbrRefiner {
    timezone_overrides: Option<TimezoneAbbrMap>,
}

impl ExtractTimezoneAbbrRefiner {
    pub fn new(timezone_overrides: Option<TimezoneAbbrMap>) -> ExtractTimezoneAbbrRefiner {
        ExtractTimezoneAbbrRefiner { timezone_overrides }
    }
}

impl Refiner for ExtractTimezoneAbbrRefiner {
    fn refine(&self, context: &ParsingContext, mut results: Vec<ParsingResult>) -> Vec<ParsingResult> {
        let timezone_overrides = &context.option.timezones;

        for result in results.iter_mut() {
            let suffix = &context.text[result.index + result.text.len()..];
            let Some(m) = js_regex!(r"^\s*,?\s*\(?([A-Z]{2,4})\)?(?=\W|$)", "i").exec(suffix) else {
                continue;
            };
            let abbr_raw = m.get(1).unwrap_or("").to_string();
            let match_text = m.text().to_string();

            let timezone_abbr = abbr_raw.to_uppercase();
            let ref_date = result.start.date();
            let mut tz_overrides = self.timezone_overrides.clone().unwrap_or_default();
            tz_overrides.extend(timezone_overrides.iter().map(|(k, v)| (k.clone(), *v)));
            let Some(extracted) = to_timezone_offset(
                Some(&TimezoneInput::Abbr(timezone_abbr.clone())),
                Some(ref_date),
                &tz_overrides,
            ) else {
                continue;
            };

            if let Some(current) = result.start.get(Component::TimezoneOffset) {
                if extracted != current {
                    // We may already have extracted the offset e.g. "11 am GMT+0900 (JST)"; trust the offset.
                    if result.start.is_certain(Component::TimezoneOffset) {
                        continue;
                    }
                    // Relative time with inferred timezone: double-check the abbr case.
                    if timezone_abbr != abbr_raw {
                        continue;
                    }
                }
            }

            if result.start.is_only_date() && timezone_abbr != abbr_raw {
                continue;
            }

            result.text.push_str(&match_text);

            if !result.start.is_certain(Component::TimezoneOffset) {
                result.start.assign(Component::TimezoneOffset, extracted);
            }
            if let Some(end) = result.end.as_mut() {
                if !end.is_certain(Component::TimezoneOffset) {
                    end.assign(Component::TimezoneOffset, extracted);
                }
            }
        }

        results
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::context::ParsingOption;
    use crate::core::js_date::JsDate;
    use crate::core::timezone::TimezoneSpec;
    use crate::locales::en::configuration::create_casual_configuration;
    use std::sync::Arc;

    fn map(pairs: &[(&str, i64)]) -> TimezoneAbbrMap {
        pairs.iter().map(|(k, v)| (k.to_string(), TimezoneSpec::Fixed(*v))).collect()
    }

    fn check(text: &str, ctor: &[(&str, i64)], opt: &[(&str, i64)], exp_text: &str, exp: Option<i64>) {
        let constructor = if ctor.is_empty() { None } else { Some(map(ctor)) };
        let mut chrono = create_casual_configuration(false).build();
        let slot = chrono.refiners.iter_mut().find(|r| r.name == UPSTREAM).unwrap();
        slot.refiner = Arc::new(ExtractTimezoneAbbrRefiner::new(constructor));
        let reference = JsDate::parse_iso("2012-08-10T12:00:00Z").unwrap();
        let option = ParsingOption {
            timezones: map(opt),
            ..Default::default()
        };
        let results = chrono.parse(text, &reference.into(), &option);
        assert_eq!(results[0].text, exp_text);
        assert_eq!(results[0].start.get(Component::TimezoneOffset), exp);
    }

    #[test]
    fn no_map() {
        check("at 10:00 XYZ", &[], &[], "at 10:00", None);
    }

    #[test]
    fn constructor_only() {
        check("at 10:00 XYZ", &[("XYZ", -180)], &[], "at 10:00 XYZ", Some(-180));
    }

    #[test]
    fn per_parse_only() {
        check("at 10:00 XYZ", &[], &[("XYZ", 60)], "at 10:00 XYZ", Some(60));
    }

    #[test]
    fn per_parse_beats_constructor() {
        check("at 10:00 XYZ", &[("XYZ", -180)], &[("XYZ", 60)], "at 10:00 XYZ", Some(60));
    }

    #[test]
    fn constructor_beats_built_in() {
        check("at 10:00 EST", &[("EST", 120)], &[], "at 10:00 EST", Some(120));
    }

    #[test]
    fn per_parse_beats_constructor_and_built_in() {
        check("at 10:00 EST", &[("EST", 120)], &[("EST", -60)], "at 10:00 EST", Some(-60));
    }

    #[test]
    fn merge_keeps_other_constructor_keys() {
        check("at 10:00 ABC", &[("ABC", 30)], &[("XYZ", 60)], "at 10:00 ABC", Some(30));
    }
}
