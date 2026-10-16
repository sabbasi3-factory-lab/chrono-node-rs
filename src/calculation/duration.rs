//! upstream `calculation/duration.ts`.

use crate::core::js_date::JsDate;

/// A key of upstream's `Duration` object, including the short aliases.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum DurationUnit {
    Year,
    Quarter,
    Month,
    Week,
    Day,
    Hour,
    Minute,
    Second,
    Millisecond,
    /// `y`
    ShortYear,
    /// `mo`
    ShortMonth,
    /// `M`
    ShortMonthUpper,
    /// `w`
    ShortWeek,
    /// `d`
    ShortDay,
    /// `h`
    ShortHour,
    /// `m`
    ShortMinute,
    /// `s`
    ShortSecond,
    /// `ms`
    ShortMillisecond,
}

impl DurationUnit {
    /// The upstream key (`"quarter"`, `"mo"`, ...).
    pub fn key(self) -> &'static str {
        use DurationUnit::*;
        match self {
            Year => "year",
            Quarter => "quarter",
            Month => "month",
            Week => "week",
            Day => "day",
            Hour => "hour",
            Minute => "minute",
            Second => "second",
            Millisecond => "millisecond",
            ShortYear => "y",
            ShortMonth => "mo",
            ShortMonthUpper => "M",
            ShortWeek => "w",
            ShortDay => "d",
            ShortHour => "h",
            ShortMinute => "m",
            ShortSecond => "s",
            ShortMillisecond => "ms",
        }
    }

    pub fn from_key(key: &str) -> Option<DurationUnit> {
        use DurationUnit::*;
        [
            Year,
            Quarter,
            Month,
            Week,
            Day,
            Hour,
            Minute,
            Second,
            Millisecond,
            ShortYear,
            ShortMonth,
            ShortMonthUpper,
            ShortWeek,
            ShortDay,
            ShortHour,
            ShortMinute,
            ShortSecond,
            ShortMillisecond,
        ]
        .into_iter()
        .find(|u| u.key() == key)
    }
}

/// upstream `Duration`: a JS object of unit -> number, keeping insertion order.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Duration(Vec<(DurationUnit, f64)>);

impl Duration {
    pub fn new() -> Duration {
        Duration(Vec::new())
    }

    pub fn from_pairs(pairs: &[(DurationUnit, f64)]) -> Duration {
        let mut d = Duration::new();
        for &(u, v) in pairs {
            d.set(u, v);
        }
        d
    }

    /// upstream `EmptyDuration`: `{ day: 0, second: 0, millisecond: 0 }`.
    pub fn empty() -> Duration {
        Duration::from_pairs(&[
            (DurationUnit::Day, 0.0),
            (DurationUnit::Second, 0.0),
            (DurationUnit::Millisecond, 0.0),
        ])
    }

    /// `unit in duration`.
    pub fn has(&self, unit: DurationUnit) -> bool {
        self.0.iter().any(|(u, _)| *u == unit)
    }

    pub fn get(&self, unit: DurationUnit) -> Option<f64> {
        self.0.iter().find(|(u, _)| *u == unit).map(|(_, v)| *v)
    }

    pub fn set(&mut self, unit: DurationUnit, value: f64) {
        match self.0.iter_mut().find(|(u, _)| *u == unit) {
            Some(slot) => slot.1 = value,
            None => self.0.push((unit, value)),
        }
    }

    pub fn remove(&mut self, unit: DurationUnit) {
        self.0.retain(|(u, _)| *u != unit);
    }

    pub fn iter(&self) -> impl Iterator<Item = (DurationUnit, f64)> + '_ {
        self.0.iter().copied()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    fn add_to(&mut self, unit: DurationUnit, amount: f64) {
        let current = self.get(unit).unwrap_or(0.0);
        self.set(unit, current + amount);
    }
}

/// JS `Math.round`: halves round up (towards +infinity).
pub fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// `addDuration(ref, duration)`. Mutates `duration` exactly like upstream.
pub fn add_duration(reference: JsDate, duration: &mut Duration) -> JsDate {
    use DurationUnit::*;
    let mut date = reference;

    for (short, long) in [
        (ShortYear, Year),
        (ShortMonth, Month),
        (ShortMonthUpper, Month),
        (ShortWeek, Week),
        (ShortDay, Day),
        (ShortHour, Hour),
        (ShortMinute, Minute),
        (ShortSecond, Second),
        (ShortMillisecond, Millisecond),
    ] {
        // `if (duration["y"])`: JS truthiness, so 0 and NaN keep the short key.
        if let Some(v) = duration.get(short) {
            if v != 0.0 && !v.is_nan() {
                duration.set(long, v);
                duration.remove(short);
            }
        }
    }

    if let Some(v) = duration.get(Year) {
        let floor = v.floor();
        date.set_full_year(date.get_full_year() + floor as i64);
        if v - floor > 0.0 {
            duration.add_to(Month, (v - floor) * 12.0);
        }
    }
    if let Some(v) = duration.get(Quarter) {
        let floor = v.floor();
        date.set_month(date.get_month() + floor as i64 * 3);
        if v - floor > 0.0 {
            duration.add_to(Month, (v - floor) * 3.0);
        }
    }
    if let Some(v) = duration.get(Month) {
        let floor = v.floor();
        date.set_month(date.get_month() + floor as i64);
        if v - floor > 0.0 {
            duration.add_to(Week, (v - floor) * 4.0);
        }
    }
    if let Some(v) = duration.get(Week) {
        let floor = v.floor();
        date.set_date(date.get_date() + floor as i64 * 7);
        if v - floor > 0.0 {
            duration.add_to(Day, js_round((v - floor) * 7.0));
        }
    }
    if let Some(v) = duration.get(Day) {
        let floor = v.floor();
        date.set_date(date.get_date() + floor as i64);
        if v - floor > 0.0 {
            duration.add_to(Hour, js_round((v - floor) * 24.0));
        }
    }
    if let Some(v) = duration.get(Hour) {
        let floor = v.floor();
        date.set_hours(date.get_hours() + floor as i64);
        if v - floor > 0.0 {
            duration.add_to(Minute, js_round((v - floor) * 60.0));
        }
    }
    if let Some(v) = duration.get(Minute) {
        let floor = v.floor();
        date.set_minutes(date.get_minutes() + floor as i64);
        if v - floor > 0.0 {
            duration.add_to(Second, js_round((v - floor) * 60.0));
        }
    }
    if let Some(v) = duration.get(Second) {
        let floor = v.floor();
        date.set_seconds(date.get_seconds() + floor as i64);
        if v - floor > 0.0 {
            duration.add_to(Millisecond, js_round((v - floor) * 1000.0));
        }
    }
    if let Some(v) = duration.get(Millisecond) {
        date.set_milliseconds(date.get_milliseconds() + v.floor() as i64);
    }
    date
}

/// `reverseDuration(duration)`.
pub fn reverse_duration(duration: &Duration) -> Duration {
    Duration(duration.iter().map(|(u, v)| (u, -v)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use DurationUnit::*;

    fn at(iso: &str) -> JsDate {
        JsDate::parse_iso(iso).unwrap()
    }

    #[test]
    fn whole_units() {
        let mut d = Duration::from_pairs(&[(Month, 1.0)]);
        assert_eq!(
            add_duration(at("2012-01-31T00:00:00.000Z"), &mut d)
                .to_iso_string()
                .unwrap(),
            "2012-03-02T00:00:00.000Z"
        );
        let mut d = Duration::from_pairs(&[(Day, -1.0), (Hour, 2.0)]);
        assert_eq!(
            add_duration(at("2012-03-01T23:00:00.000Z"), &mut d)
                .to_iso_string()
                .unwrap(),
            "2012-03-01T01:00:00.000Z"
        );
    }

    #[test]
    fn fractions_cascade_and_mutate_like_js() {
        // 1.5 days -> 1 day + round(0.5 * 24) = 12 hours; upstream adds "hour" to the object.
        let mut d = Duration::from_pairs(&[(Day, 1.5)]);
        let out = add_duration(at("2012-08-10T00:00:00.000Z"), &mut d);
        assert_eq!(out.to_iso_string().unwrap(), "2012-08-11T12:00:00.000Z");
        assert_eq!(d.get(Hour), Some(12.0));
        // Short keys are renamed in place.
        let mut d = Duration::from_pairs(&[(ShortDay, 2.0), (ShortYear, 0.0)]);
        add_duration(at("2012-08-10T00:00:00.000Z"), &mut d);
        assert!(d.has(Day) && !d.has(ShortDay) && d.has(ShortYear));
    }

    #[test]
    fn js_round_halves_up() {
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0);
    }

    #[test]
    fn reverse() {
        let d = reverse_duration(&Duration::from_pairs(&[(Week, 2.0), (Day, 1.0)]));
        assert_eq!(d, Duration::from_pairs(&[(Week, -2.0), (Day, -1.0)]));
    }
}
