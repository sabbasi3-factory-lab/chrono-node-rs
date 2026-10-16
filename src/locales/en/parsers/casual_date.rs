//! upstream `locales/en/parsers/ENCasualDateParser.ts`.

use crate::common::casual_references as references;
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::Component;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::dates::assign_similar_date;
use crate::js_regex;

pub const UPSTREAM: &str = "ENCasualDateParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(EnCasualDateParser))
}

struct EnCasualDateParser;

impl WordBoundaryParser for EnCasualDateParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        js_regex!(r"(now|today|tonight|tomorrow|overmorrow|tmr|tmrw|yesterday|last\s*night)(?=\W|$)", "i").clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let mut target_date = context.ref_date;
        let lower_text = m.text().to_lowercase();
        let mut component = context.create_parsing_components(&[]);

        match lower_text.as_str() {
            "now" => component = references::now(context.reference),
            "today" => component = references::today(context.reference),
            "yesterday" => component = references::yesterday(context.reference),
            "tomorrow" | "tmr" | "tmrw" => component = references::tomorrow(context.reference),
            "tonight" => component = references::tonight(context.reference, 22),
            "overmorrow" => component = references::the_day_after(context.reference, 2),
            _ => {
                if js_regex!(r"last\s*night").is_match(&lower_text) {
                    if target_date.get_hours() > 6 {
                        let mut previous_day = target_date;
                        previous_day.set_date(previous_day.get_date() - 1);
                        target_date = previous_day;
                    }
                    assign_similar_date(&mut component, target_date);
                    component.imply(Component::Hour, 0);
                }
            }
        }
        component.add_tag("parser/ENCasualDateParser");
        Extracted::Components(component)
    }
}
