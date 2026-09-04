//! GUI sub-views: focused panels the shell ([`super`]) renders inside its
//! central panel. T8 adds the [`voice`] picker; T9's settings panel lives
//! beside this tree in [`super::settings`] (it persists, not just renders).
//! Later efforts may add the job detail view here.
//!
//! Views are presentational: they render state they're handed and return
//! user intents (e.g. a picked voice id) — no view owns queue or executor
//! state, keeping the T6 invariant intact.

pub mod voice;
