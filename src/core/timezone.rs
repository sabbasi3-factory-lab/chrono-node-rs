//! upstream `timezone.ts`: time zone abbreviations and `toTimezoneOffset`.

use super::components::weekday;
use super::js_date::JsDate;
use std::collections::BTreeMap;

/// A DST boundary for a year (upstream `dstStart` / `dstEnd`).
pub type DstRule = fn(i64) -> JsDate;

/// upstream `number | AmbiguousTimezoneMap`.
#[derive(Clone, Copy, Debug)]
pub enum TimezoneSpec {
    /// A fixed offset in minutes.
    Fixed(i64),
    /// An abbreviation whose offset depends on DST at the reference date (e.g. `ET`).
    Ambiguous {
        offset_during_dst: i64,
        offset_non_dst: i64,
        dst_start: DstRule,
        dst_end: DstRule,
    },
}

impl PartialEq for TimezoneSpec {
    fn eq(&self, other: &Self) -> bool {
        use std::ptr::fn_addr_eq;
        match (self, other) {
            (Fixed(a), Fixed(b)) => a == b,
            (
                TimezoneSpec::Ambiguous {
                    offset_during_dst: a1,
                    offset_non_dst: a2,
                    dst_start: a3,
                    dst_end: a4,
                },
                TimezoneSpec::Ambiguous {
                    offset_during_dst: b1,
                    offset_non_dst: b2,
                    dst_start: b3,
                    dst_end: b4,
                },
            ) => a1 == b1 && a2 == b2 && fn_addr_eq(*a3, *b3) && fn_addr_eq(*a4, *b4),
            _ => false,
        }
    }
}

/// upstream `TimezoneAbbrMap` (used for `ParsingOption.timezones` overrides).
pub type TimezoneAbbrMap = BTreeMap<String, TimezoneSpec>;

/// upstream `ParsingReference.timezone`: an abbreviation or an offset in minutes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TimezoneInput {
    Abbr(String),
    Minutes(i64),
}

use TimezoneSpec::Fixed;

fn cet_dst_start(year: i64) -> JsDate {
    get_last_weekday_of_month(year, 3, weekday::SUNDAY, 2)
}
fn cet_dst_end(year: i64) -> JsDate {
    get_last_weekday_of_month(year, 10, weekday::SUNDAY, 3)
}
fn us_dst_start(year: i64) -> JsDate {
    get_nth_weekday_of_month(year, 3, weekday::SUNDAY, 2, 2)
}
fn us_dst_end(year: i64) -> JsDate {
    get_nth_weekday_of_month(year, 11, weekday::SUNDAY, 1, 2)
}

const fn us(during_dst: i64, non_dst: i64) -> TimezoneSpec {
    TimezoneSpec::Ambiguous {
        offset_during_dst: during_dst,
        offset_non_dst: non_dst,
        dst_start: us_dst_start,
        dst_end: us_dst_end,
    }
}

/// upstream `TIMEZONE_ABBR_MAP` (case-sensitive keys, like upstream).
pub static TIMEZONE_ABBR_MAP: &[(&str, TimezoneSpec)] = &[
    (
        "CET",
        TimezoneSpec::Ambiguous {
            offset_during_dst: 120,
            offset_non_dst: 60,
            dst_start: cet_dst_start,
            dst_end: cet_dst_end,
        },
    ),
    ("CT", us(-300, -360)),
    ("ET", us(-240, -300)),
    ("MT", us(-360, -420)),
    ("PT", us(-420, -480)),
    ("ACDT", Fixed(630)),
    ("ACST", Fixed(570)),
    ("ADT", Fixed(-180)),
    ("AEDT", Fixed(660)),
    ("AEST", Fixed(600)),
    ("AFT", Fixed(270)),
    ("AKDT", Fixed(-480)),
    ("AKST", Fixed(-540)),
    ("ALMT", Fixed(360)),
    ("AMST", Fixed(-180)),
    ("AMT", Fixed(-240)),
    ("ANAST", Fixed(720)),
    ("ANAT", Fixed(720)),
    ("AQTT", Fixed(300)),
    ("ART", Fixed(-180)),
    ("AST", Fixed(-240)),
    ("AWDT", Fixed(540)),
    ("AWST", Fixed(480)),
    ("AZOST", Fixed(0)),
    ("AZOT", Fixed(-60)),
    ("AZST", Fixed(300)),
    ("AZT", Fixed(240)),
    ("BNT", Fixed(480)),
    ("BOT", Fixed(-240)),
    ("BRST", Fixed(-120)),
    ("BRT", Fixed(-180)),
    ("BST", Fixed(60)),
    ("BTT", Fixed(360)),
    ("CAST", Fixed(480)),
    ("CAT", Fixed(120)),
    ("CCT", Fixed(390)),
    ("CDT", Fixed(-300)),
    ("CEST", Fixed(120)),
    ("timezoneOffsetDuringDst", Fixed(120)),
    ("timezoneOffsetNonDst", Fixed(60)),
    ("CHADT", Fixed(825)),
    ("CHAST", Fixed(765)),
    ("CKT", Fixed(-600)),
    ("CLST", Fixed(-180)),
    ("CLT", Fixed(-240)),
    ("COT", Fixed(-300)),
    ("CST", Fixed(-360)),
    ("timezoneOffsetDuringDst", Fixed(-300)),
    ("timezoneOffsetNonDst", Fixed(-360)),
    ("CVT", Fixed(-60)),
    ("CXT", Fixed(420)),
    ("ChST", Fixed(600)),
    ("DAVT", Fixed(420)),
    ("EASST", Fixed(-300)),
    ("EAST", Fixed(-360)),
    ("EAT", Fixed(180)),
    ("ECT", Fixed(-300)),
    ("EDT", Fixed(-240)),
    ("EEST", Fixed(180)),
    ("EET", Fixed(120)),
    ("EGST", Fixed(0)),
    ("EGT", Fixed(-60)),
    ("EST", Fixed(-300)),
    ("timezoneOffsetDuringDst", Fixed(-240)),
    ("timezoneOffsetNonDst", Fixed(-300)),
    ("FJST", Fixed(780)),
    ("FJT", Fixed(720)),
    ("FKST", Fixed(-180)),
    ("FKT", Fixed(-240)),
    ("FNT", Fixed(-120)),
    ("GALT", Fixed(-360)),
    ("GAMT", Fixed(-540)),
    ("GET", Fixed(240)),
    ("GFT", Fixed(-180)),
    ("GILT", Fixed(720)),
    ("GMT", Fixed(0)),
    ("GST", Fixed(240)),
    ("GYT", Fixed(-240)),
    ("HAA", Fixed(-180)),
    ("HAC", Fixed(-300)),
    ("HADT", Fixed(-540)),
    ("HAE", Fixed(-240)),
    ("HAP", Fixed(-420)),
    ("HAR", Fixed(-360)),
    ("HAST", Fixed(-600)),
    ("HAT", Fixed(-90)),
    ("HAY", Fixed(-480)),
    ("HKT", Fixed(480)),
    ("HLV", Fixed(-210)),
    ("HNA", Fixed(-240)),
    ("HNC", Fixed(-360)),
    ("HNE", Fixed(-300)),
    ("HNP", Fixed(-480)),
    ("HNR", Fixed(-420)),
    ("HNT", Fixed(-150)),
    ("HNY", Fixed(-540)),
    ("HOVT", Fixed(420)),
    ("ICT", Fixed(420)),
    ("IDT", Fixed(180)),
    ("IOT", Fixed(360)),
    ("IRDT", Fixed(270)),
    ("IRKST", Fixed(540)),
    ("IRKT", Fixed(540)),
    ("IRST", Fixed(210)),
    ("IST", Fixed(330)),
    ("JST", Fixed(540)),
    ("KGT", Fixed(360)),
    ("KRAST", Fixed(480)),
    ("KRAT", Fixed(480)),
    ("KST", Fixed(540)),
    ("KUYT", Fixed(240)),
    ("LHDT", Fixed(660)),
    ("LHST", Fixed(630)),
    ("LINT", Fixed(840)),
    ("MAGST", Fixed(720)),
    ("MAGT", Fixed(720)),
    ("MART", Fixed(-510)),
    ("MAWT", Fixed(300)),
    ("MDT", Fixed(-360)),
    ("MESZ", Fixed(120)),
    ("MEZ", Fixed(60)),
    ("MHT", Fixed(720)),
    ("MMT", Fixed(390)),
    ("MSD", Fixed(240)),
    ("MSK", Fixed(180)),
    ("MST", Fixed(-420)),
    ("timezoneOffsetDuringDst", Fixed(-360)),
    ("timezoneOffsetNonDst", Fixed(-420)),
    ("MUT", Fixed(240)),
    ("MVT", Fixed(300)),
    ("MYT", Fixed(480)),
    ("NCT", Fixed(660)),
    ("NDT", Fixed(-90)),
    ("NFT", Fixed(690)),
    ("NOVST", Fixed(420)),
    ("NOVT", Fixed(360)),
    ("NPT", Fixed(345)),
    ("NST", Fixed(-150)),
    ("NUT", Fixed(-660)),
    ("NZDT", Fixed(780)),
    ("NZST", Fixed(720)),
    ("OMSST", Fixed(420)),
    ("OMST", Fixed(420)),
    ("PDT", Fixed(-420)),
    ("PET", Fixed(-300)),
    ("PETST", Fixed(720)),
    ("PETT", Fixed(720)),
    ("PGT", Fixed(600)),
    ("PHOT", Fixed(780)),
    ("PHT", Fixed(480)),
    ("PKT", Fixed(300)),
    ("PMDT", Fixed(-120)),
    ("PMST", Fixed(-180)),
    ("PONT", Fixed(660)),
    ("PST", Fixed(-480)),
    ("timezoneOffsetDuringDst", Fixed(-420)),
    ("timezoneOffsetNonDst", Fixed(-480)),
    ("PWT", Fixed(540)),
    ("PYST", Fixed(-180)),
    ("PYT", Fixed(-240)),
    ("RET", Fixed(240)),
    ("SAMT", Fixed(240)),
    ("SAST", Fixed(120)),
    ("SBT", Fixed(660)),
    ("SCT", Fixed(240)),
    ("SGT", Fixed(480)),
    ("SRT", Fixed(-180)),
    ("SST", Fixed(-660)),
    ("TAHT", Fixed(-600)),
    ("TFT", Fixed(300)),
    ("TJT", Fixed(300)),
    ("TKT", Fixed(780)),
    ("TLT", Fixed(540)),
    ("TMT", Fixed(300)),
    ("TVT", Fixed(720)),
    ("ULAT", Fixed(480)),
    ("UTC", Fixed(0)),
    ("UYST", Fixed(-120)),
    ("UYT", Fixed(-180)),
    ("UZT", Fixed(300)),
    ("VET", Fixed(-210)),
    ("VLAST", Fixed(660)),
    ("VLAT", Fixed(660)),
    ("VUT", Fixed(660)),
    ("WAST", Fixed(120)),
    ("WAT", Fixed(60)),
    ("WEST", Fixed(60)),
    ("WESZ", Fixed(60)),
    ("WET", Fixed(0)),
    ("WEZ", Fixed(0)),
    ("WFT", Fixed(720)),
    ("WGST", Fixed(-120)),
    ("WGT", Fixed(-180)),
    ("WIB", Fixed(420)),
    ("WIT", Fixed(540)),
    ("WITA", Fixed(480)),
    ("WST", Fixed(780)),
    ("WT", Fixed(0)),
    ("YAKST", Fixed(600)),
    ("YAKT", Fixed(600)),
    ("YAPT", Fixed(600)),
    ("YEKST", Fixed(360)),
    ("YEKT", Fixed(360)),
];

pub fn lookup(abbr: &str) -> Option<TimezoneSpec> {
    TIMEZONE_ABBR_MAP.iter().find(|(k, _)| *k == abbr).map(|(_, v)| *v)
}

/// `getNthWeekdayOfMonth(year, month, weekday, n, hour)`; month is 1–12.
pub fn get_nth_weekday_of_month(year: i64, month: i64, weekday: i64, n: i64, hour: i64) -> JsDate {
    let mut day_of_month = 0;
    let mut i = 0;
    while i < n {
        day_of_month += 1;
        if JsDate::local(year, month - 1, day_of_month, 0, 0, 0, 0).get_day() == weekday {
            i += 1;
        }
    }
    JsDate::local(year, month - 1, day_of_month, hour, 0, 0, 0)
}

/// `getLastWeekdayOfMonth(year, month, weekday, hour)`; month is 1–12.
pub fn get_last_weekday_of_month(year: i64, month: i64, weekday: i64, hour: i64) -> JsDate {
    let one_indexed_weekday = if weekday == 0 { 7 } else { weekday };
    let mut date = JsDate::local(year, month - 1 + 1, 1, 12, 0, 0, 0);
    let first_weekday_next_month = if date.get_day() == 0 { 7 } else { date.get_day() };
    let day_diff = if first_weekday_next_month == one_indexed_weekday {
        7
    } else if first_weekday_next_month < one_indexed_weekday {
        7 + first_weekday_next_month - one_indexed_weekday
    } else {
        first_weekday_next_month - one_indexed_weekday
    };
    date.set_date(date.get_date() - day_diff);
    JsDate::local(year, month - 1, date.get_date(), hour, 0, 0, 0)
}

/// JS `a > b` on dates: false if either is NaN.
fn date_gt(a: JsDate, b: JsDate) -> bool {
    matches!((a.get_time(), b.get_time()), (Some(a), Some(b)) if a > b)
}

/// `toTimezoneOffset(timezoneInput, date, timezoneOverrides)`.
pub fn to_timezone_offset(
    input: Option<&TimezoneInput>,
    date: Option<JsDate>,
    overrides: &TimezoneAbbrMap,
) -> Option<i64> {
    let abbr = match input? {
        TimezoneInput::Minutes(m) => return Some(*m),
        TimezoneInput::Abbr(a) => a,
    };
    let spec = overrides.get(abbr).copied().or_else(|| lookup(abbr))?;
    match spec {
        Fixed(offset) => Some(offset),
        TimezoneSpec::Ambiguous {
            offset_during_dst,
            offset_non_dst,
            dst_start,
            dst_end,
        } => {
            let date = date?;
            let year = date.get_full_year();
            if date_gt(date, dst_start(year)) && !date_gt(date, dst_end(year)) {
                Some(offset_during_dst)
            } else {
                Some(offset_non_dst)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_size_matches_upstream() {
        // 198 fixed entries + 5 ambiguous ones in upstream/src/timezone.ts.
        assert_eq!(TIMEZONE_ABBR_MAP.len(), 203);
    }

    #[test]
    fn fixed_and_ambiguous() {
        let none = TimezoneAbbrMap::new();
        assert_eq!(
            to_timezone_offset(Some(&TimezoneInput::Abbr("CDT".into())), None, &none),
            Some(-300)
        );
        assert_eq!(
            to_timezone_offset(Some(&TimezoneInput::Abbr("JST".into())), None, &none),
            Some(540)
        );
        assert_eq!(
            to_timezone_offset(Some(&TimezoneInput::Abbr("XYZ".into())), None, &none),
            None
        );
        assert_eq!(
            to_timezone_offset(Some(&TimezoneInput::Minutes(-90)), None, &none),
            Some(-90)
        );
        let summer = JsDate::parse_iso("2021-07-01T00:00:00.000Z");
        let winter = JsDate::parse_iso("2021-01-15T00:00:00.000Z");
        assert_eq!(
            to_timezone_offset(Some(&TimezoneInput::Abbr("ET".into())), summer, &none),
            Some(-240)
        );
        assert_eq!(
            to_timezone_offset(Some(&TimezoneInput::Abbr("ET".into())), winter, &none),
            Some(-300)
        );
        assert_eq!(
            to_timezone_offset(Some(&TimezoneInput::Abbr("ET".into())), None, &none),
            None
        );
        let mut overrides = TimezoneAbbrMap::new();
        overrides.insert("JST".into(), Fixed(1));
        assert_eq!(
            to_timezone_offset(Some(&TimezoneInput::Abbr("JST".into())), None, &overrides),
            Some(1)
        );
    }

    #[test]
    fn dst_boundaries() {
        // US DST 2021: Mar 14 02:00 to Nov 7 02:00; EU: Mar 28 02:00 to Oct 31 03:00.
        assert_eq!(us_dst_start(2021).to_iso_string().unwrap(), "2021-03-14T02:00:00.000Z");
        assert_eq!(us_dst_end(2021).to_iso_string().unwrap(), "2021-11-07T02:00:00.000Z");
        assert_eq!(cet_dst_start(2021).to_iso_string().unwrap(), "2021-03-28T02:00:00.000Z");
        assert_eq!(cet_dst_end(2021).to_iso_string().unwrap(), "2021-10-31T03:00:00.000Z");
    }
}
