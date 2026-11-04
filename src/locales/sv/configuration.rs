//! upstream `locales/sv/index.ts`: `createCasualConfiguration` and `createConfiguration`.
//!
//! The slot order and flags must match `tests/golden/configurations.json` exactly; the
//! `configurations` test checks it.

use crate::common::configuration::include_common_configuration;
use crate::core::configuration::{Configuration, Flags};

/// `createCasualConfiguration(littleEndian)`.
pub fn create_casual_configuration(little_endian: bool) -> Configuration {
    let mut option = create_configuration(false, little_endian);
    option.unshift_parser("SVCasualDateParser", Flags::none());
    option
}

/// `createConfiguration(strictMode, littleEndian)`.
pub fn create_configuration(strict_mode: bool, little_endian: bool) -> Configuration {
    let mut options = Configuration::default();
    // Upstream lists ISOFormatParser itself, and includeCommonConfiguration adds it again.
    options.push_parser("ISOFormatParser", Flags::none());
    options.push_parser("SlashDateFormatParser", Flags::of(&[("littleEndian", little_endian)]));
    options.push_parser("SVMonthNameLittleEndianParser", Flags::none());
    options.push_parser("SVWeekdayParser", Flags::none());
    // Constructed with no argument: allowAbbreviations defaults to true.
    options.push_parser(
        "SVTimeUnitCasualRelativeFormatParser",
        Flags::of(&[("allowAbbreviations", true)]),
    );

    include_common_configuration(&mut options, strict_mode);
    options
}
