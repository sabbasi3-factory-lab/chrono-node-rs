//! upstream `ParsingResult`.

use super::components::ParsingComponents;
use super::js_date::JsDate;
use super::reference::ReferenceWithTimezone;

/// upstream `ParsingResult`. `index` is a **byte** offset into the parsed text; JSON output
/// converts it to UTF-16 units to match JavaScript.
#[derive(Clone, Debug, PartialEq)]
pub struct ParsingResult {
    pub reference: ReferenceWithTimezone,
    pub ref_date: JsDate,
    pub index: usize,
    pub text: String,
    pub start: ParsingComponents,
    pub end: Option<ParsingComponents>,
}

impl ParsingResult {
    /// `new ParsingResult(reference, index, text, start?, end?)`.
    pub fn new(
        reference: ReferenceWithTimezone,
        index: usize,
        text: impl Into<String>,
        start: Option<ParsingComponents>,
        end: Option<ParsingComponents>,
    ) -> ParsingResult {
        ParsingResult {
            reference,
            ref_date: reference.instant,
            index,
            text: text.into(),
            start: start.unwrap_or_else(|| ParsingComponents::new(reference, &[])),
            end,
        }
    }

    /// `date()`.
    pub fn date(&self) -> JsDate {
        self.start.date()
    }

    pub fn add_tag(&mut self, tag: &str) -> &mut Self {
        self.start.add_tag(tag);
        if let Some(end) = self.end.as_mut() {
            end.add_tag(tag);
        }
        self
    }

    pub fn add_tags<'a>(&mut self, tags: impl IntoIterator<Item = &'a str> + Clone) -> &mut Self {
        self.start.add_tags(tags.clone());
        if let Some(end) = self.end.as_mut() {
            end.add_tags(tags);
        }
        self
    }

    /// `tags()`: start's tags, then end's, without duplicates.
    pub fn tags(&self) -> Vec<String> {
        let mut tags: Vec<String> = self.start.tags().to_vec();
        if let Some(end) = &self.end {
            for t in end.tags() {
                if !tags.contains(t) {
                    tags.push(t.clone());
                }
            }
        }
        tags
    }
}
