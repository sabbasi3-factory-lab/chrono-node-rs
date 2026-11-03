//! upstream `locales/de/index.ts`: `createCasualConfiguration` and `createConfiguration`.
//!
//! The slot order and flags must match `tests/golden/configurations.json` exactly; the
//! `configurations` test checks it.

use crate::common::configuration::include_common_configuration;
use crate::core::configuration::{Configuration, Flags};

/// `createCasualConfiguration(littleEndian)`.
pub fn create_casual_configuration(little_endian: bool) -> Configuration {
    let mut option = create_configuration(false, little_endian);
    option.unshift_parser("DECasualTimeParser", Flags::none());
    option.unshift_parser("DECasualDateParser", Flags::none());
    // Upstream's DETimeUnitRelativeFormatParser.ts declares a class named DETimeUnitAgoFormatParser;
    // the harness names it after its file (see harness/lib/serialize.js).
    option.unshift_parser("DETimeUnitRelativeFormatParser", Flags::none());
    option
}

/// `createConfiguration(strictMode, littleEndian)`.
pub fn create_configuration(strict_mode: bool, little_endian: bool) -> Configuration {
    let mut options = Configuration::default();
    options.push_parser("ISOFormatParser", Flags::none());
    options.push_parser("SlashDateFormatParser", Flags::of(&[("littleEndian", little_endian)]));
    // Upstream constructs it with no argument, so strictMode is always false here.
    options.push_parser("DETimeExpressionParser", Flags::of(&[("strictMode", false)]));
    options.push_parser("DESpecificTimeExpressionParser", Flags::none());
    options.push_parser("DEMonthNameLittleEndianParser", Flags::none());
    options.push_parser("DEWeekdayParser", Flags::none());
    options.push_parser("DETimeUnitWithinFormatParser", Flags::none());
    options.push_refiner("DEMergeDateRangeRefiner", Flags::none());
    options.push_refiner("DEMergeDateTimeRefiner", Flags::none());

    include_common_configuration(&mut options, strict_mode);
    options
}
