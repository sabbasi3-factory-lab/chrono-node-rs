//! upstream `locales/fr/index.ts`: `createCasualConfiguration` and `createConfiguration`.
//!
//! The slot order and flags must match `tests/golden/configurations.json` exactly; the
//! `configurations` test checks it.

use crate::common::configuration::include_common_configuration;
use crate::core::configuration::{Configuration, Flags};

/// `createCasualConfiguration(littleEndian)`.
pub fn create_casual_configuration(little_endian: bool) -> Configuration {
    let mut option = create_configuration(false, little_endian);
    option.unshift_parser("FRCasualDateParser", Flags::none());
    option.unshift_parser("FRCasualTimeParser", Flags::none());
    // Upstream's FRTimeUnitRelativeFormatParser.ts declares a class named FRTimeUnitAgoFormatParser;
    // the harness names it after its file, so it differs from the real FRTimeUnitAgoFormatParser
    // (see harness/lib/serialize.js).
    option.unshift_parser("FRTimeUnitRelativeFormatParser", Flags::none());
    option
}

/// `createConfiguration(strictMode, littleEndian)`.
pub fn create_configuration(strict_mode: bool, little_endian: bool) -> Configuration {
    let mut options = Configuration::default();
    options.push_parser("SlashDateFormatParser", Flags::of(&[("littleEndian", little_endian)]));
    options.push_parser("FRMonthNameLittleEndianParser", Flags::none());
    // Upstream constructs it with no argument, so strictMode is always false here.
    options.push_parser("FRTimeExpressionParser", Flags::of(&[("strictMode", false)]));
    options.push_parser("FRSpecificTimeExpressionParser", Flags::none());
    options.push_parser("FRTimeUnitAgoFormatParser", Flags::none());
    options.push_parser("FRTimeUnitWithinFormatParser", Flags::none());
    options.push_parser("FRWeekdayParser", Flags::none());
    options.push_refiner("FRMergeDateTimeRefiner", Flags::none());
    options.push_refiner("FRMergeDateRangeRefiner", Flags::none());

    include_common_configuration(&mut options, strict_mode);
    options
}
