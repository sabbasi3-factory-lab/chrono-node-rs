//! upstream `locales/ar/parsers/ARCasualTimeParser.ts`.

use crate::common::casual_references as references;
use crate::common::word_boundary::{WithWordBoundary, WordBoundaryParser};
use crate::core::chrono::{Extracted, Parser};
use crate::core::configuration::Flags;
use crate::core::context::ParsingContext;
use crate::core::regex::{JsRegex, RegexMatch};
use crate::js_regex;
use crate::locales::ar::abstract_parser_with_word_boundary_checking::{
    left_right_boundary_inner_pattern, pattern_left_boundary,
};

pub const UPSTREAM: &str = "ARCasualTimeParser";

pub fn create(_flags: &Flags) -> Box<dyn Parser> {
    Box::new(WithWordBoundary::new(ArCasualTimeParser))
}

struct ArCasualTimeParser;

impl WordBoundaryParser for ArCasualTimeParser {
    fn pattern_left_boundary(&self) -> &str {
        pattern_left_boundary()
    }

    fn inner_pattern(&self, _context: &ParsingContext) -> JsRegex {
        left_right_boundary_inner_pattern(
            r"(مساء\s*(?:أمس|امس|البارحة)|(?:أمس|امس|البارحة)\s*مساءً?|ليلة\s*(?:أمس|امس|البارحة)|(?:أمس|امس|البارحة)\s*ليلاً?|الليلة\s*الماضية|منتصف\s*النهار|منتصف\s*الليل|هذا\s*الصباح|هذا\s*المساء|هذه\s*الليلة|بعد\s*الظهر|ظهر\s*اليوم|الصباح|صباحاً|صباحا|الظهر|ظهراً|ظهرا|العصر|عصراً|عصرا|المساء|مساءً|مساء|الليلة|الليل|ليلاً|ليلا)",
        )
    }

    fn inner_extract(&self, context: &ParsingContext, m: &mut RegexMatch) -> Extracted {
        let lower_text = m.get(1).unwrap_or("").to_lowercase();
        let t = lower_text.as_str();
        let reference = context.reference;

        if js_regex!(r"مساء\s*(?:أمس|امس|البارحة)").is_match(t)
            || js_regex!(r"(?:أمس|امس|البارحة)\s*مساء").is_match(t)
        {
            return Extracted::Components(references::yesterday_evening(reference, 20));
        }

        if js_regex!(r"ليلة\s*(?:أمس|امس|البارحة)").is_match(t)
            || js_regex!(r"(?:أمس|امس|البارحة)\s*ليلاً?").is_match(t)
            || t == "الليلة الماضية"
        {
            return Extracted::Components(references::last_night(reference, 0));
        }

        if t == "هذه الليلة" || t == "الليلة" {
            return Extracted::Components(references::tonight(reference, 22));
        }

        if t == "منتصف الليل" {
            return Extracted::Components(references::midnight(reference));
        }

        if matches!(t, "منتصف النهار" | "ظهر اليوم" | "الظهر" | "ظهراً" | "ظهرا") {
            return Extracted::Components(references::noon(reference));
        }

        if matches!(t, "بعد الظهر" | "العصر" | "عصراً" | "عصرا") {
            return Extracted::Components(references::afternoon(reference, 15));
        }

        if matches!(t, "هذا الصباح" | "الصباح" | "صباحاً" | "صباحا") {
            return Extracted::Components(references::morning(reference, 6));
        }

        if matches!(t, "هذا المساء" | "المساء" | "مساءً" | "مساء") {
            return Extracted::Components(references::evening(reference, 20));
        }

        if matches!(t, "الليل" | "ليلاً" | "ليلا") {
            return Extracted::Components(references::evening(reference, 22));
        }

        Extracted::Components(context.create_parsing_components(&[]))
    }
}
