//! upstream `locales/ja/index.ts`: `createCasualConfiguration` and `createConfiguration`.
//!
//! The slot order and flags must match `tests/golden/configurations.json` exactly; the
//! `configurations` test checks it.

use crate::common::configuration::include_common_configuration;
use crate::core::configuration::{Configuration, Flags};

/// `createCasualConfiguration()`.
pub fn create_casual_configuration() -> Configuration {
    let mut option = create_configuration(false);
    option.unshift_parser("JPCasualDateParser", Flags::none());
    option
}

/// `createConfiguration(strictMode)`.
pub fn create_configuration(strict_mode: bool) -> Configuration {
    let mut configuration = Configuration::default();
    configuration.push_parser("JPStandardParser", Flags::none());
    configuration.push_parser("JPWeekdayParser", Flags::none());
    configuration.push_parser("JPWeekdayWithParenthesesParser", Flags::none());
    configuration.push_parser("JPSlashDateFormatParser", Flags::none());
    configuration.push_parser("JPTimeExpressionParser", Flags::none());
    // Should be before JPMergeDateTimeRefiner and JPMergeDateRangeRefiner (upstream note).
    configuration.push_refiner("JPMergeWeekdayComponentRefiner", Flags::none());
    configuration.push_refiner("JPMergeDateTimeRefiner", Flags::none());
    configuration.push_refiner("JPMergeDateRangeRefiner", Flags::none());
    include_common_configuration(&mut configuration, strict_mode);

    // Upstream removes it: not used in Japanese grammar (`refiner instanceof MergeWeekdayComponentRefiner`;
    // JPMergeWeekdayComponentRefiner isn't a subclass of it).
    configuration.remove_refiners("MergeWeekdayComponentRefiner");
    configuration
}
