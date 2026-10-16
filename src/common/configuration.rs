//! upstream `configurations.ts`: `includeCommonConfiguration`.

use crate::core::configuration::{Configuration, Flags};

/// `includeCommonConfiguration(configuration, strictMode)`.
pub fn include_common_configuration(configuration: &mut Configuration, strict_mode: bool) {
    configuration.unshift_parser("ISOFormatParser", Flags::none());

    configuration.unshift_refiner("MergeWeekdayComponentRefiner", Flags::none());
    configuration.unshift_refiner("ExtractTimezoneOffsetRefiner", Flags::none());
    configuration.unshift_refiner("OverlapRemovalRefiner", Flags::none());

    // Applied as late as possible: it needs both date and time for ambiguous (DST) abbreviations.
    configuration.push_refiner("ExtractTimezoneAbbrRefiner", Flags::none());
    configuration.push_refiner("OverlapRemovalRefiner", Flags::none());
    configuration.push_refiner("ForwardDateRefiner", Flags::none());
    configuration.push_refiner("UnlikelyFormatFilter", Flags::of(&[("strictMode", strict_mode)]));
}
