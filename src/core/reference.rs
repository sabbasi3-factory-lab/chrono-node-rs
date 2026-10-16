//! upstream `ReferenceWithTimezone` and `ParsingReference`.

use super::js_date::JsDate;
use super::timezone::{to_timezone_offset, TimezoneAbbrMap, TimezoneInput};

/// upstream `ParsingReference`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ParsingReference {
    pub instant: Option<JsDate>,
    pub timezone: Option<TimezoneInput>,
}

/// The `refDate` argument of `parse`: nothing ("now"), a `Date`, or a `ParsingReference`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum ReferenceInput {
    #[default]
    Now,
    Date(JsDate),
    Reference(ParsingReference),
}

impl From<JsDate> for ReferenceInput {
    fn from(date: JsDate) -> Self {
        ReferenceInput::Date(date)
    }
}

impl From<ParsingReference> for ReferenceInput {
    fn from(reference: ParsingReference) -> Self {
        ReferenceInput::Reference(reference)
    }
}

/// upstream `ReferenceWithTimezone`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReferenceWithTimezone {
    pub instant: JsDate,
    /// Minutes east of UTC, or `None` (use the system time zone, which is UTC).
    pub timezone_offset: Option<i64>,
}

impl ReferenceWithTimezone {
    pub fn new(instant: JsDate, timezone_offset: Option<i64>) -> ReferenceWithTimezone {
        ReferenceWithTimezone {
            instant,
            timezone_offset,
        }
    }

    /// `ReferenceWithTimezone.fromInput(input, timezoneOverrides)`. `now` is used where upstream calls `new Date()`.
    pub fn from_input(input: &ReferenceInput, overrides: &TimezoneAbbrMap, now: JsDate) -> ReferenceWithTimezone {
        match input {
            ReferenceInput::Date(date) => ReferenceWithTimezone::new(*date, None),
            ReferenceInput::Now => ReferenceWithTimezone::new(now, to_timezone_offset(None, Some(now), overrides)),
            ReferenceInput::Reference(r) => {
                let instant = r.instant.unwrap_or(now);
                let offset = to_timezone_offset(r.timezone.as_ref(), Some(instant), overrides);
                ReferenceWithTimezone::new(instant, offset)
            }
        }
    }

    /// `getDateWithAdjustedTimezone()`: a date whose (system-local = UTC) fields equal the
    /// reference's wall-clock fields in the reference time zone.
    pub fn get_date_with_adjusted_timezone(&self) -> JsDate {
        let mut date = self.instant;
        if self.timezone_offset.is_some() {
            date.set_minutes(date.get_minutes() - self.get_system_timezone_adjustment_minute(Some(self.instant), None));
        }
        date
    }

    /// `getSystemTimezoneAdjustmentMinute(date, overrideTimezoneOffset)`.
    pub fn get_system_timezone_adjustment_minute(&self, date: Option<JsDate>, override_offset: Option<i64>) -> i64 {
        let date = date.unwrap_or_else(JsDate::now);
        let current = -date.get_timezone_offset();
        let target = override_offset.or(self.timezone_offset).unwrap_or(current);
        current - target
    }

    /// `getTimezoneOffset()`.
    pub fn get_timezone_offset(&self) -> i64 {
        self.timezone_offset.unwrap_or(-self.instant.get_timezone_offset())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adjusted_date_shifts_into_reference_zone() {
        let instant = JsDate::parse_iso("2021-06-09T12:00:00.000Z").unwrap();
        let r = ReferenceWithTimezone::from_input(
            &ReferenceInput::Reference(ParsingReference {
                instant: Some(instant),
                timezone: Some(TimezoneInput::Abbr("CDT".into())),
            }),
            &TimezoneAbbrMap::new(),
            JsDate::INVALID,
        );
        assert_eq!(r.timezone_offset, Some(-300));
        assert_eq!(
            r.get_date_with_adjusted_timezone().to_iso_string().unwrap(),
            "2021-06-09T07:00:00.000Z"
        );
        assert_eq!(r.get_timezone_offset(), -300);
    }

    #[test]
    fn plain_date_has_no_offset() {
        let instant = JsDate::parse_iso("2021-06-09T12:00:00.000Z").unwrap();
        let r = ReferenceWithTimezone::from_input(&instant.into(), &TimezoneAbbrMap::new(), JsDate::INVALID);
        assert_eq!(r.timezone_offset, None);
        assert_eq!(r.get_date_with_adjusted_timezone(), instant);
        assert_eq!(r.get_timezone_offset(), 0);
    }
}
