//! upstream `locales/en/configuration.ts`: `ENDefaultConfiguration`.
//!
//! The slot order and flags must match `tests/golden/configurations.json` exactly; the
//! `configurations` test checks it.

use crate::common::configuration::include_common_configuration;
use crate::core::configuration::{Configuration, Flags};

/// `createCasualConfiguration(littleEndian)`.
pub fn create_casual_configuration(little_endian: bool) -> Configuration {
    let mut option = create_configuration(false, little_endian);
    option.push_parser("ENCasualDateParser", Flags::none());
    option.push_parser("ENCasualTimeParser", Flags::none());
    option.push_parser("ENEndOfCurrentMonthParser", Flags::none());
    option.push_parser("ENMonthNameParser", Flags::none());
    option.push_parser("ENRelativeDateFormatParser", Flags::none());
    option.push_parser(
        "ENTimeUnitCasualRelativeFormatParser",
        Flags::of(&[("allowAbbreviations", true)]),
    );
    option.unshift_refiner("ENEndOfPeriodRefiner", Flags::none());
    option.push_refiner("ENUnlikelyFormatFilter", Flags::none());
    option
}

/// `createConfiguration(strictMode, littleEndian)`.
pub fn create_configuration(strict_mode: bool, little_endian: bool) -> Configuration {
    let strict = Flags::of(&[("strictMode", strict_mode)]);
    let mut options = Configuration::default();
    options.push_parser("SlashDateFormatParser", Flags::of(&[("littleEndian", little_endian)]));
    options.push_parser("ENTimeUnitWithinFormatParser", strict.clone());
    options.push_parser("ENMonthNameLittleEndianParser", Flags::none());
    options.push_parser(
        "ENMonthNameMiddleEndianParser",
        Flags::of(&[("shouldSkipYearLikeDate", little_endian)]),
    );
    options.push_parser("ENWeekdayParser", Flags::none());
    options.push_parser("ENSlashMonthFormatParser", Flags::none());
    options.push_parser("ENTimeExpressionParser", strict.clone());
    options.push_parser("ENTimeUnitAgoFormatParser", strict.clone());
    options.push_parser("ENTimeUnitLaterFormatParser", strict);
    options.push_parser("ENYearMonthNameParser", Flags::none());
    options.push_refiner("ENMergeDateTimeRefiner", Flags::none());

    include_common_configuration(&mut options, strict_mode);
    options.unshift_parser(
        "ENYearMonthDayParser",
        Flags::of(&[("strictMonthDateOrder", strict_mode)]),
    );

    // These relative-dates consideration should be done before other common refiners.
    options.unshift_refiner("ENMergeRelativeFollowByDateRefiner", Flags::none());
    options.unshift_refiner("ENMergeRelativeAfterDateRefiner", Flags::none());
    options.unshift_refiner("OverlapRemovalRefiner", Flags::none());

    // Re-apply the date time refiner again after the timezone refinement and exclusion in common refiners.
    options.push_refiner("ENMergeDateTimeRefiner", Flags::none());
    // Extract year after merging date and time
    options.push_refiner("ENExtractYearSuffixRefiner", Flags::none());
    // Keep the date range refiner at the end (after all other refinements).
    options.push_refiner("ENMergeDateRangeRefiner", Flags::none());
    options
}
