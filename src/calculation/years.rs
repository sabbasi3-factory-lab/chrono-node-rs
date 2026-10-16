//! upstream `calculation/years.ts`.

use crate::calculation::duration::{add_duration, Duration, DurationUnit};
use crate::core::js_date::JsDate;

/// `findMostLikelyADYear(yearNumber)`: 97 -> 1997, 12 -> 2012.
pub fn find_most_likely_ad_year(year_number: i64) -> i64 {
    if year_number < 100 {
        if year_number > 50 {
            year_number + 1900
        } else {
            year_number + 2000
        }
    } else {
        year_number
    }
}

/// `findYearClosestToRef(refDate, day, month)`.
pub fn find_year_closest_to_ref(ref_date: JsDate, day: i64, month: i64) -> i64 {
    let mut date = ref_date;
    date.set_month(month - 1);
    date.set_date(day);
    let next_year = add_duration(date, &mut Duration::from_pairs(&[(DurationUnit::Year, 1.0)]));
    let last_year = add_duration(date, &mut Duration::from_pairs(&[(DurationUnit::Year, -1.0)]));
    let distance = |d: JsDate| match (d.get_time(), ref_date.get_time()) {
        (Some(a), Some(b)) => Some((a - b).abs()),
        _ => None,
    };
    // JS `<` with NaN is false.
    let lt = |a: Option<i64>, b: Option<i64>| matches!((a, b), (Some(a), Some(b)) if a < b);
    if lt(distance(next_year), distance(date)) {
        date = next_year;
    } else if lt(distance(last_year), distance(date)) {
        date = last_year;
    }
    date.get_full_year()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn most_likely_year() {
        assert_eq!(find_most_likely_ad_year(97), 1997);
        assert_eq!(find_most_likely_ad_year(12), 2012);
        assert_eq!(find_most_likely_ad_year(50), 2050);
        assert_eq!(find_most_likely_ad_year(2012), 2012);
    }

    #[test]
    fn closest_year() {
        let r = JsDate::parse_iso("2012-12-20T00:00:00.000Z").unwrap();
        assert_eq!(find_year_closest_to_ref(r, 2, 1), 2013);
        let r = JsDate::parse_iso("2013-01-05T00:00:00.000Z").unwrap();
        assert_eq!(find_year_closest_to_ref(r, 28, 12), 2012);
        assert_eq!(find_year_closest_to_ref(r, 1, 6), 2013);
    }
}
