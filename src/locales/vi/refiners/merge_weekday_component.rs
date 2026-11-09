//! upstream `locales/vi/refiners/VIMergeWeekdayComponentRefiner.ts`: a subclass of
//! `MergeWeekdayComponentRefiner` with no overrides.
//!
//! Merges a weekday with an adjacent date/time component: [thứ Hai] [lúc 7 giờ] => [thứ Hai lúc 7 giờ].

use crate::common::abstract_refiners::Merging;
use crate::common::refiners::merge_weekday_component::MergeWeekdayComponentRefiner;
use crate::core::chrono::Refiner;
use crate::core::configuration::Flags;

pub const UPSTREAM: &str = "VIMergeWeekdayComponentRefiner";

pub fn create(_flags: &Flags) -> Box<dyn Refiner> {
    Box::new(Merging::new(MergeWeekdayComponentRefiner))
}
