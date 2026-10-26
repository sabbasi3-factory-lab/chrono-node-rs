//! `ParsingComponents` (upstream `results.ts`): known and implied date/time components.

use super::js_date::JsDate;
use super::reference::ReferenceWithTimezone;
use crate::calculation::duration::{add_duration, Duration, DurationUnit};

/// upstream `Component`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Component {
    Year,
    Month,
    Day,
    Weekday,
    Hour,
    Minute,
    Second,
    Millisecond,
    Meridiem,
    TimezoneOffset,
}

impl Component {
    pub const ALL: [Component; 10] = [
        Component::Year,
        Component::Month,
        Component::Day,
        Component::Weekday,
        Component::Hour,
        Component::Minute,
        Component::Second,
        Component::Millisecond,
        Component::Meridiem,
        Component::TimezoneOffset,
    ];

    /// The upstream name (`"timezoneOffset"`), as used in golden data.
    pub fn name(self) -> &'static str {
        match self {
            Component::Year => "year",
            Component::Month => "month",
            Component::Day => "day",
            Component::Weekday => "weekday",
            Component::Hour => "hour",
            Component::Minute => "minute",
            Component::Second => "second",
            Component::Millisecond => "millisecond",
            Component::Meridiem => "meridiem",
            Component::TimezoneOffset => "timezoneOffset",
        }
    }

    pub fn from_name(name: &str) -> Option<Component> {
        Component::ALL.into_iter().find(|c| c.name() == name)
    }
}

/// upstream `Meridiem`.
pub mod meridiem {
    pub const AM: i64 = 0;
    pub const PM: i64 = 1;
}

/// upstream `Weekday` (0 = Sunday).
pub mod weekday {
    pub const SUNDAY: i64 = 0;
    pub const MONDAY: i64 = 1;
    pub const TUESDAY: i64 = 2;
    pub const WEDNESDAY: i64 = 3;
    pub const THURSDAY: i64 = 4;
    pub const FRIDAY: i64 = 5;
    pub const SATURDAY: i64 = 6;
}

/// A JS object `{ [c in Component]?: number }`, keeping insertion order like JS does.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ComponentMap(Vec<(Component, i64)>);

impl ComponentMap {
    pub fn new() -> ComponentMap {
        ComponentMap(Vec::new())
    }

    pub fn from_pairs(pairs: &[(Component, i64)]) -> ComponentMap {
        let mut map = ComponentMap::new();
        for &(c, v) in pairs {
            map.set(c, v);
        }
        map
    }

    pub fn get(&self, c: Component) -> Option<i64> {
        self.0.iter().find(|(k, _)| *k == c).map(|(_, v)| *v)
    }

    pub fn contains(&self, c: Component) -> bool {
        self.0.iter().any(|(k, _)| *k == c)
    }

    /// Assignment keeps an existing key's position, like a JS object.
    pub fn set(&mut self, c: Component, v: i64) {
        match self.0.iter_mut().find(|(k, _)| *k == c) {
            Some(slot) => slot.1 = v,
            None => self.0.push((c, v)),
        }
    }

    pub fn remove(&mut self, c: Component) {
        self.0.retain(|(k, _)| *k != c);
    }

    pub fn keys(&self) -> impl Iterator<Item = Component> + '_ {
        self.0.iter().map(|(k, _)| *k)
    }

    pub fn iter(&self) -> impl Iterator<Item = (Component, i64)> + '_ {
        self.0.iter().copied()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// upstream `ParsingComponents`.
///
/// Rust's `Clone` copies everything, tags included. Upstream's `clone()` doesn't copy tags: port
/// an upstream `.clone()` as [`ParsingComponents::js_clone`] (see `PORTING.md`).
#[derive(Clone, Debug, PartialEq)]
pub struct ParsingComponents {
    reference: ReferenceWithTimezone,
    known: ComponentMap,
    implied: ComponentMap,
    tags: Vec<String>,
}

impl ParsingComponents {
    /// `new ParsingComponents(reference, knownComponents)`.
    pub fn new(reference: ReferenceWithTimezone, known: &[(Component, i64)]) -> ParsingComponents {
        let mut c = ParsingComponents {
            reference,
            known: ComponentMap::from_pairs(known),
            implied: ComponentMap::new(),
            tags: Vec::new(),
        };
        let date = reference.get_date_with_adjusted_timezone();
        c.imply(Component::Day, date.get_date());
        c.imply(Component::Month, date.get_month() + 1);
        c.imply(Component::Year, date.get_full_year());
        c.imply(Component::Hour, 12);
        c.imply(Component::Minute, 0);
        c.imply(Component::Second, 0);
        c.imply(Component::Millisecond, 0);
        c
    }

    /// `ParsingComponents.createRelativeFromReference(reference, duration)`.
    /// Like upstream, `duration` is mutated by `add_duration` (short keys renamed, fractions cascaded).
    pub fn create_relative_from_reference(
        reference: ReferenceWithTimezone,
        duration: &mut Duration,
    ) -> ParsingComponents {
        let date = add_duration(reference.get_date_with_adjusted_timezone(), duration);

        let mut c = ParsingComponents::new(reference, &[]);
        c.add_tag("result/relativeDate");
        let has = |u| duration.has(u);
        if has(DurationUnit::Hour)
            || has(DurationUnit::Minute)
            || has(DurationUnit::Second)
            || has(DurationUnit::Millisecond)
        {
            c.add_tag("result/relativeDateAndTime");
            crate::core::utils::dates::assign_similar_time(&mut c, date);
            crate::core::utils::dates::assign_similar_date(&mut c, date);
            c.assign(Component::TimezoneOffset, reference.get_timezone_offset());
        } else {
            crate::core::utils::dates::imply_similar_time(&mut c, date);
            c.imply(Component::TimezoneOffset, reference.get_timezone_offset());
            if has(DurationUnit::Day) {
                c.assign(Component::Day, date.get_date());
                c.assign(Component::Month, date.get_month() + 1);
                c.assign(Component::Year, date.get_full_year());
                c.assign(Component::Weekday, date.get_day());
            } else if has(DurationUnit::Week) {
                c.assign(Component::Day, date.get_date());
                c.assign(Component::Month, date.get_month() + 1);
                c.assign(Component::Year, date.get_full_year());
                c.imply(Component::Weekday, date.get_day());
            } else {
                c.imply(Component::Day, date.get_date());
                if has(DurationUnit::Month) {
                    c.assign(Component::Month, date.get_month() + 1);
                    c.assign(Component::Year, date.get_full_year());
                } else {
                    c.imply(Component::Month, date.get_month() + 1);
                    if has(DurationUnit::Year) {
                        c.assign(Component::Year, date.get_full_year());
                    } else {
                        c.imply(Component::Year, date.get_full_year());
                    }
                }
            }
        }
        c
    }

    pub fn reference(&self) -> ReferenceWithTimezone {
        self.reference
    }

    /// `get(component)`: known, else implied, else `None` (JS `null`).
    pub fn get(&self, c: Component) -> Option<i64> {
        self.known.get(c).or_else(|| self.implied.get(c))
    }

    /// `get(c)` where upstream relies on JS turning `null` into 0 in arithmetic.
    pub fn get_or_zero(&self, c: Component) -> i64 {
        self.get(c).unwrap_or(0)
    }

    pub fn is_certain(&self, c: Component) -> bool {
        self.known.contains(c)
    }

    pub fn get_certain_components(&self) -> Vec<Component> {
        self.known.keys().collect()
    }

    pub fn known_values(&self) -> &ComponentMap {
        &self.known
    }

    pub fn implied_values(&self) -> &ComponentMap {
        &self.implied
    }

    /// `imply(component, value)`: ignored if the component is already known.
    pub fn imply(&mut self, c: Component, v: i64) -> &mut Self {
        if !self.known.contains(c) {
            self.implied.set(c, v);
        }
        self
    }

    /// `assign(component, value)`.
    pub fn assign(&mut self, c: Component, v: i64) -> &mut Self {
        self.known.set(c, v);
        self.implied.remove(c);
        self
    }

    /// `addDurationAsImplied(duration)`. Like upstream, `duration` is mutated by `add_duration`.
    pub fn add_duration_as_implied(&mut self, duration: &mut Duration) -> &mut Self {
        let current = self.date_without_timezone_adjustment();
        let date = add_duration(current, duration);
        let has = |u| duration.has(u);
        if has(DurationUnit::Day) || has(DurationUnit::Week) || has(DurationUnit::Month) || has(DurationUnit::Year) {
            self.delete(&[Component::Day, Component::Weekday, Component::Month, Component::Year]);
            self.imply(Component::Day, date.get_date());
            self.imply(Component::Weekday, date.get_day());
            self.imply(Component::Month, date.get_month() + 1);
            self.imply(Component::Year, date.get_full_year());
        }
        if has(DurationUnit::Second) || has(DurationUnit::Minute) || has(DurationUnit::Hour) {
            self.delete(&[Component::Second, Component::Minute, Component::Hour]);
            self.imply(Component::Second, date.get_seconds());
            self.imply(Component::Minute, date.get_minutes());
            self.imply(Component::Hour, date.get_hours());
        }
        self
    }

    pub fn delete(&mut self, components: &[Component]) {
        for &c in components {
            self.known.remove(c);
            self.implied.remove(c);
        }
    }

    pub fn is_only_date(&self) -> bool {
        !self.is_certain(Component::Hour) && !self.is_certain(Component::Minute) && !self.is_certain(Component::Second)
    }

    pub fn is_only_time(&self) -> bool {
        !self.is_certain(Component::Weekday)
            && !self.is_certain(Component::Day)
            && !self.is_certain(Component::Month)
            && !self.is_certain(Component::Year)
    }

    pub fn is_only_weekday_component(&self) -> bool {
        self.is_certain(Component::Weekday) && !self.is_certain(Component::Day) && !self.is_certain(Component::Month)
    }

    pub fn is_date_with_unknown_year(&self) -> bool {
        self.is_certain(Component::Month) && !self.is_certain(Component::Year)
    }

    fn utc_from_fields(&self) -> JsDate {
        let g = |c| self.get_or_zero(c);
        let mut date = JsDate::utc(
            g(Component::Year),
            g(Component::Month) - 1,
            g(Component::Day),
            g(Component::Hour),
            g(Component::Minute),
            g(Component::Second),
            g(Component::Millisecond),
        );
        date.set_full_year(g(Component::Year));
        date
    }

    /// `isValidDate()`.
    pub fn is_valid_date(&self) -> bool {
        let date = self.utc_from_fields();
        if !date.is_valid() {
            return false;
        }
        let g = |c| self.get_or_zero(c);
        if date.get_full_year() != g(Component::Year) {
            return false;
        }
        if date.get_month() != g(Component::Month) - 1 {
            return false;
        }
        if date.get_date() != g(Component::Day) {
            return false;
        }
        if self.get(Component::Hour).is_some_and(|h| date.get_hours() != h) {
            return false;
        }
        if self.get(Component::Minute).is_some_and(|m| date.get_minutes() != m) {
            return false;
        }
        true
    }

    /// `date()`: the instant these components describe.
    pub fn date(&self) -> JsDate {
        let offset = self.get(Component::TimezoneOffset).or(self.reference.timezone_offset);
        match offset {
            None => self.date_without_timezone_adjustment(),
            Some(offset) => match self.utc_from_fields().get_time() {
                Some(t) => JsDate::from_millis(t - offset * 60_000),
                None => JsDate::INVALID,
            },
        }
    }

    /// The components read as system-local time (UTC here), with `setFullYear` fixing 0–99 years.
    pub fn date_without_timezone_adjustment(&self) -> JsDate {
        let g = |c| self.get_or_zero(c);
        let mut date = JsDate::local(
            g(Component::Year),
            g(Component::Month) - 1,
            g(Component::Day),
            g(Component::Hour),
            g(Component::Minute),
            g(Component::Second),
            g(Component::Millisecond),
        );
        date.set_full_year(g(Component::Year));
        date
    }

    pub fn add_tag(&mut self, tag: &str) -> &mut Self {
        if !self.tags.iter().any(|t| t == tag) {
            self.tags.push(tag.to_string());
        }
        self
    }

    pub fn add_tags<'a>(&mut self, tags: impl IntoIterator<Item = &'a str>) -> &mut Self {
        for tag in tags {
            self.add_tag(tag);
        }
        self
    }

    /// Tags in insertion order (a JS `Set`).
    /// upstream `clone()`: the reference and the known and implied values, **without the tags**.
    /// Use this wherever upstream calls `.clone()` on components.
    pub fn js_clone(&self) -> ParsingComponents {
        ParsingComponents {
            reference: self.reference,
            known: self.known.clone(),
            implied: self.implied.clone(),
            tags: Vec::new(),
        }
    }

    pub fn tags(&self) -> &[String] {
        &self.tags
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reference() -> ReferenceWithTimezone {
        ReferenceWithTimezone::new(JsDate::parse_iso("2012-08-10T09:30:00.000Z").unwrap(), None)
    }

    #[test]
    fn js_clone_keeps_values_and_drops_tags_like_upstream() {
        let mut c = ParsingComponents::new(reference(), &[(Component::Day, 21), (Component::Month, 7)]);
        c.imply(Component::Year, 2038);
        c.add_tag("parser/ENMonthNameMiddleEndianParser");
        let js = c.js_clone();
        assert_eq!(js.get(Component::Day), Some(21));
        assert_eq!(js.get(Component::Year), Some(2038));
        assert!(js.is_certain(Component::Month));
        assert!(!js.is_certain(Component::Year));
        assert!(js.tags().is_empty(), "upstream clone() doesn't copy tags");
        assert_eq!(c.clone().tags(), c.tags(), "Rust Clone does");
    }

    #[test]
    fn new_implies_reference_day_and_noon() {
        let c = ParsingComponents::new(reference(), &[(Component::Weekday, 1)]);
        assert_eq!(c.get(Component::Day), Some(10));
        assert_eq!(c.get(Component::Hour), Some(12));
        assert!(c.is_certain(Component::Weekday));
        assert!(!c.is_certain(Component::Day));
        assert_eq!(c.get(Component::TimezoneOffset), None);
        assert_eq!(c.date().to_iso_string().unwrap(), "2012-08-10T12:00:00.000Z");
    }

    #[test]
    fn assign_and_imply() {
        let mut c = ParsingComponents::new(reference(), &[]);
        c.assign(Component::Hour, 5).imply(Component::Hour, 7);
        assert_eq!(c.get(Component::Hour), Some(5));
        c.assign(Component::TimezoneOffset, 60);
        assert_eq!(c.date().to_iso_string().unwrap(), "2012-08-10T04:00:00.000Z");
    }

    #[test]
    fn add_duration_as_implied_crosses_month() {
        let mut c = ParsingComponents::new(reference(), &[]);
        c.add_duration_as_implied(&mut Duration::from_pairs(&[(DurationUnit::Day, 25.0)]));
        assert_eq!(
            (
                c.get(Component::Month),
                c.get(Component::Day),
                c.get(Component::Weekday)
            ),
            (Some(9), Some(4), Some(2))
        );
        assert!(!c.is_certain(Component::Day));
    }

    #[test]
    fn validity() {
        let c = ParsingComponents::new(reference(), &[(Component::Month, 2), (Component::Day, 30)]);
        assert!(!c.is_valid_date());
        let c = ParsingComponents::new(reference(), &[(Component::Month, 2), (Component::Day, 29)]);
        assert!(c.is_valid_date()); // 2012 is a leap year
    }
}
