//! upstream `locales/es/index.ts`: `createCasualConfiguration` and `createConfiguration`.
//!
//! The slot order and flags must match `tests/golden/configurations.json` exactly; the
//! `configurations` test checks it.

use crate::common::configuration::include_common_configuration;
use crate::core::configuration::{Configuration, Flags};

/// `createCasualConfiguration(littleEndian)`.
pub fn create_casual_configuration(little_endian: bool) -> Configuration {
    let mut option = create_configuration(false, little_endian);
    option.push_parser("ESCasualDateParser", Flags::none());
    option.push_parser("ESCasualTimeParser", Flags::none());
    option.push_parser("ESMonthNameParser", Flags::none());
    option
}

/// `createConfiguration(strictMode, littleEndian)`.
pub fn create_configuration(strict_mode: bool, little_endian: bool) -> Configuration {
    let mut options = Configuration::default();
    options.push_parser("SlashDateFormatParser", Flags::of(&[("littleEndian", little_endian)]));
    options.push_parser("ESWeekdayParser", Flags::none());
    // Upstream constructs it with no argument, so strictMode is always false here.
    options.push_parser("ESTimeExpressionParser", Flags::of(&[("strictMode", false)]));
    options.push_parser("ESMonthNameLittleEndianParser", Flags::none());
    options.push_parser(
        "ESTimeUnitWithinFormatParser",
        Flags::of(&[("strictMode", strict_mode)]),
    );
    options.push_refiner("ESMergeDateTimeRefiner", Flags::none());
    options.push_refiner("ESMergeDateRangeRefiner", Flags::none());

    include_common_configuration(&mut options, strict_mode);
    options
}
