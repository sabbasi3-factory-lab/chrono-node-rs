//! The JavaScript `Date` operations chrono-node uses, emulated exactly.
//!
//! chrono-node's results depend on JS `Date` arithmetic: overflow in `setDate`/`setMonth`, the
//! 0–99 year mapping of `new Date(y, m, d)`, and so on. This type reproduces those rules on a
//! millisecond time value.
//!
//! **The system time zone is always UTC.** The golden data is recorded with `TZ=UTC`, so JS "local"
//! getters and setters behave exactly like the UTC ones. A reference's own time zone is handled
//! separately by `ReferenceWithTimezone`, as upstream does.

use std::time::{SystemTime, UNIX_EPOCH};

const MS_PER_DAY: i128 = 86_400_000;
const MAX_TIME: i128 = 8_640_000_000_000_000;

/// A JS `Date`: a millisecond time value, or `None` for an invalid date (JS `NaN`).
/// Deliberately not `Ord`: compare `get_time()` values, so `NaN` comparisons stay explicit.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct JsDate {
    t: Option<i64>,
}

fn floor_div(a: i128, b: i128) -> i128 {
    let q = a / b;
    if (a % b != 0) && ((a < 0) != (b < 0)) {
        q - 1
    } else {
        q
    }
}

fn floor_mod(a: i128, b: i128) -> i128 {
    a - floor_div(a, b) * b
}

/// Days since 1970-01-01 for a proleptic Gregorian date (month 1–12).
fn days_from_civil(y: i128, m: i128, d: i128) -> i128 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = floor_div(y, 400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// (year, month 1–12, day 1–31) for days since 1970-01-01.
fn civil_from_days(z: i128) -> (i128, i128, i128) {
    let z = z + 719_468;
    let era = floor_div(z, 146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// ECMAScript MakeDay: month is 0-based and may overflow in either direction.
fn make_day(year: i64, month: i64, date: i64) -> Option<i128> {
    let (year, month, date) = (year as i128, month as i128, date as i128);
    let ym = year + floor_div(month, 12);
    if ym.abs() > 400_000 {
        return None;
    }
    let mn = floor_mod(month, 12);
    Some(days_from_civil(ym, mn + 1, 1) + date - 1)
}

fn make_time(h: i64, m: i64, s: i64, ms: i64) -> i128 {
    h as i128 * 3_600_000 + m as i128 * 60_000 + s as i128 * 1000 + ms as i128
}

fn time_clip(t: i128) -> Option<i64> {
    (t.abs() <= MAX_TIME).then_some(t as i64)
}

fn make_date(day: Option<i128>, time: i128) -> Option<i64> {
    day.and_then(|day| time_clip(day * MS_PER_DAY + time))
}

impl JsDate {
    /// `new Date(NaN)`.
    pub const INVALID: JsDate = JsDate { t: None };

    /// `new Date(ms)`.
    pub fn from_millis(ms: i64) -> JsDate {
        JsDate {
            t: time_clip(ms as i128),
        }
    }

    /// `new Date()`.
    pub fn now() -> JsDate {
        let ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        JsDate::from_millis(ms)
    }

    /// `new Date(y, m, d, h, mi, s, ms)` (local time = UTC here). Like JS, years 0–99 mean 1900–1999.
    pub fn local(year: i64, month: i64, day: i64, hour: i64, minute: i64, second: i64, ms: i64) -> JsDate {
        let year = if (0..=99).contains(&year) { 1900 + year } else { year };
        JsDate {
            t: make_date(make_day(year, month, day), make_time(hour, minute, second, ms)),
        }
    }

    /// `Date.UTC(...)`. Same as [`JsDate::local`] because the system time zone is UTC.
    pub fn utc(year: i64, month: i64, day: i64, hour: i64, minute: i64, second: i64, ms: i64) -> JsDate {
        JsDate::local(year, month, day, hour, minute, second, ms)
    }

    pub fn is_valid(&self) -> bool {
        self.t.is_some()
    }

    /// `getTime()`; `None` is JS `NaN`.
    pub fn get_time(&self) -> Option<i64> {
        self.t
    }

    fn parts(&self) -> Option<(i128, i128, i128, i128, i128)> {
        let t = self.t? as i128;
        let day = floor_div(t, MS_PER_DAY);
        let (y, m, d) = civil_from_days(day);
        Some((y, m, d, day, t - day * MS_PER_DAY))
    }

    // Getters. On an invalid date JS returns NaN; we return 0. chrono-node never reads an
    // invalid date's fields on the code paths the golden tests cover (see PORTING.md).

    pub fn get_full_year(&self) -> i64 {
        self.parts().map_or(0, |p| p.0 as i64)
    }
    /// 0-based, like JS.
    pub fn get_month(&self) -> i64 {
        self.parts().map_or(0, |p| p.1 as i64 - 1)
    }
    pub fn get_date(&self) -> i64 {
        self.parts().map_or(0, |p| p.2 as i64)
    }
    /// 0 = Sunday.
    pub fn get_day(&self) -> i64 {
        self.parts().map_or(0, |p| floor_mod(p.3 + 4, 7) as i64)
    }
    pub fn get_hours(&self) -> i64 {
        self.parts().map_or(0, |p| (p.4 / 3_600_000) as i64)
    }
    pub fn get_minutes(&self) -> i64 {
        self.parts().map_or(0, |p| (p.4 / 60_000 % 60) as i64)
    }
    pub fn get_seconds(&self) -> i64 {
        self.parts().map_or(0, |p| (p.4 / 1000 % 60) as i64)
    }
    pub fn get_milliseconds(&self) -> i64 {
        self.parts().map_or(0, |p| (p.4 % 1000) as i64)
    }
    /// Always 0: the system time zone is UTC.
    pub fn get_timezone_offset(&self) -> i64 {
        0
    }

    fn time_within_day(&self) -> i128 {
        self.parts().map_or(0, |p| p.4)
    }

    fn rebuild(&mut self, year: i64, month: i64, day: i64, time: i128) {
        self.t = make_date(make_day(year, month, day), time);
    }

    /// `setFullYear(y)`. Like JS, an invalid date is treated as time 0 first.
    pub fn set_full_year(&mut self, year: i64) {
        if self.t.is_none() {
            self.t = Some(0);
        }
        let (m, d, time) = (self.get_month(), self.get_date(), self.time_within_day());
        self.rebuild(year, m, d, time);
    }

    /// `setMonth(m)` (0-based). Keeps the day of month, so Jan 31 + 1 month overflows into March.
    pub fn set_month(&mut self, month: i64) {
        if self.t.is_some() {
            let (y, d, time) = (self.get_full_year(), self.get_date(), self.time_within_day());
            self.rebuild(y, month, d, time);
        }
    }

    /// `setDate(d)`.
    pub fn set_date(&mut self, day: i64) {
        if self.t.is_some() {
            let (y, m, time) = (self.get_full_year(), self.get_month(), self.time_within_day());
            self.rebuild(y, m, day, time);
        }
    }

    fn set_time_fields(&mut self, h: i64, mi: i64, s: i64, ms: i64) {
        if let Some((y, m, d, _, _)) = self.parts() {
            self.t = make_date(make_day(y as i64, m as i64 - 1, d as i64), make_time(h, mi, s, ms));
        }
    }

    pub fn set_hours(&mut self, hour: i64) {
        let (mi, s, ms) = (self.get_minutes(), self.get_seconds(), self.get_milliseconds());
        self.set_time_fields(hour, mi, s, ms);
    }
    pub fn set_minutes(&mut self, minute: i64) {
        let (h, s, ms) = (self.get_hours(), self.get_seconds(), self.get_milliseconds());
        self.set_time_fields(h, minute, s, ms);
    }
    pub fn set_seconds(&mut self, second: i64) {
        let (h, mi, ms) = (self.get_hours(), self.get_minutes(), self.get_milliseconds());
        self.set_time_fields(h, mi, second, ms);
    }
    pub fn set_milliseconds(&mut self, ms: i64) {
        let (h, mi, s) = (self.get_hours(), self.get_minutes(), self.get_seconds());
        self.set_time_fields(h, mi, s, ms);
    }

    /// `toISOString()`. `None` where JS would throw (invalid date).
    pub fn to_iso_string(&self) -> Option<String> {
        let (y, m, d, _, tod) = self.parts()?;
        let (h, mi, s, ms) = (tod / 3_600_000, tod / 60_000 % 60, tod / 1000 % 60, tod % 1000);
        let year = if (0..=9999).contains(&y) {
            format!("{y:04}")
        } else if y < 0 {
            format!("-{:06}", -y)
        } else {
            format!("+{y:06}")
        };
        Some(format!("{year}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{ms:03}Z"))
    }

    /// Parses the `toISOString()` format (`YYYY-MM-DDTHH:mm:ss.sssZ`, or `±YYYYYY-...`).
    pub fn parse_iso(s: &str) -> Option<JsDate> {
        let (sign, rest) = match s.as_bytes().first()? {
            b'+' => (1, &s[1..]),
            b'-' => (-1, &s[1..]),
            _ => (1, s),
        };
        let (date, time) = rest.strip_suffix('Z')?.split_once('T')?;
        let mut dp = date.split('-');
        let year: i64 = dp.next()?.parse().ok()?;
        let month: i64 = dp.next()?.parse().ok()?;
        let day: i64 = dp.next()?.parse().ok()?;
        let (hms, ms) = time.split_once('.').unwrap_or((time, "0"));
        let mut tp = hms.split(':');
        let h: i64 = tp.next()?.parse().ok()?;
        let mi: i64 = tp.next()?.parse().ok()?;
        let sec: i64 = tp.next()?.parse().ok()?;
        let ms: i64 = ms.parse().ok()?;
        let t = make_date(make_day(sign * year, month - 1, day), make_time(h, mi, sec, ms))?;
        Some(JsDate::from_millis(t))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn epoch_and_iso() {
        let d = JsDate::from_millis(0);
        assert_eq!(d.to_iso_string().unwrap(), "1970-01-01T00:00:00.000Z");
        assert_eq!(d.get_day(), 4); // Thursday
        let d = JsDate::parse_iso("2012-08-09T00:00:00.000Z").unwrap();
        assert_eq!(
            (d.get_full_year(), d.get_month(), d.get_date(), d.get_day()),
            (2012, 7, 9, 4)
        );
        assert_eq!(
            JsDate::parse_iso("-000001-01-01T00:00:00.000Z")
                .unwrap()
                .to_iso_string()
                .unwrap(),
            "-000001-01-01T00:00:00.000Z"
        );
        assert_eq!(
            JsDate::parse_iso("+012345-06-07T08:09:10.011Z")
                .unwrap()
                .to_iso_string()
                .unwrap(),
            "+012345-06-07T08:09:10.011Z"
        );
    }

    #[test]
    fn js_overflow_rules() {
        // new Date(2012, 0, 31).setMonth(1) -> 2012-03-02 (leap year)
        let mut d = JsDate::local(2012, 0, 31, 0, 0, 0, 0);
        d.set_month(1);
        assert_eq!(d.to_iso_string().unwrap(), "2012-03-02T00:00:00.000Z");
        // setDate(0) -> last day of previous month
        let mut d = JsDate::local(2013, 2, 15, 12, 0, 0, 0);
        d.set_date(0);
        assert_eq!(d.to_iso_string().unwrap(), "2013-02-28T12:00:00.000Z");
        // negative month
        let d = JsDate::local(2013, -1, 1, 0, 0, 0, 0);
        assert_eq!(d.to_iso_string().unwrap(), "2012-12-01T00:00:00.000Z");
        // hours overflow
        let mut d = JsDate::local(2013, 11, 31, 23, 0, 0, 0);
        d.set_hours(25);
        assert_eq!(d.to_iso_string().unwrap(), "2014-01-01T01:00:00.000Z");
        let mut d = JsDate::local(2013, 0, 1, 0, 0, 0, 0);
        d.set_minutes(-1);
        assert_eq!(d.to_iso_string().unwrap(), "2012-12-31T23:59:00.000Z");
    }

    #[test]
    fn two_digit_years_map_to_1900s_like_js() {
        assert_eq!(JsDate::local(99, 0, 1, 0, 0, 0, 0).get_full_year(), 1999);
        let mut d = JsDate::local(0, 1, 29, 0, 0, 0, 0); // 1900 is not leap -> Mar 1
        d.set_full_year(0);
        assert_eq!(d.to_iso_string().unwrap(), "0000-03-01T00:00:00.000Z");
    }

    #[test]
    fn time_clip_makes_invalid() {
        assert!(!JsDate::local(300_000, 0, 1, 0, 0, 0, 0).is_valid());
        assert!(JsDate::from_millis(8_640_000_000_000_000).is_valid());
        assert!(!JsDate::from_millis(8_640_000_000_000_001).is_valid());
        let mut d = JsDate::INVALID;
        d.set_full_year(2000);
        assert_eq!(d.to_iso_string().unwrap(), "2000-01-01T00:00:00.000Z");
    }
}
