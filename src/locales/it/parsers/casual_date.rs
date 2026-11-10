//! upstream `locales/it/parsers/ITCasualDateParser.ts`.

use crate::common::casual_references as references;
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::components::Component;
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::core::utils::dates::assign_similar_date;
use crate::js_regex;

pub const UPSTREAM: &str = "ITCasualDateParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(ItCasualDateParser))
}

struct ItCasualDateParser;

impl WordBoundaryParser for ItCasualDateParser {
    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        js_regex!(
            r"(adesso|ora|oggi|stasera|stanotte|domani|dopodomani|ieri|ieri\s*sera|ieri\s*notte)(?=\W|$)",
            "i"
        )
        .clone()
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let mut target_date = context.ref_date;
        let lower_text = m.text().to_lowercase();
        let mut component = context.create_parsing_components(&[]);

        match lower_text.as_str() {
            "adesso" | "ora" => component = references::now(context.reference),
            "oggi" => component = references::today(context.reference),
            "ieri" => component = references::yesterday(context.reference),
            "domani" => component = references::tomorrow(context.reference),
            "stasera" | "stanotte" => component = references::tonight(context.reference, 22),
            "dopodomani" => component = references::the_day_after(context.reference, 2),
            _ => {
                if js_regex!(r"ieri\s*sera").is_match(&lower_text) || js_regex!(r"ieri\s*notte").is_match(&lower_text) {
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
        component.add_tag("parser/ITCasualDateParser");
        Extracted::Components(component)
    }
}
