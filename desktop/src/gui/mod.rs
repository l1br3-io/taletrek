//! The GUI half of `taletrek-desktop` (effort `desktop-synth-gui`).
//!
//! T6 lands the pure, UI-free job-queue state machine first ([`queue`]);
//! the eframe shell (T7+) renders it and forwards user actions as events.
//! egui never appears outside this module — `queue.rs` stays importable
//! with zero UI dependencies.

// Compiled ahead of its first consumer: the egui shell (T7) is the reader of
// this state machine; until it lands, nothing outside tests touches the
// queue. Drop this allow when the executor wires in.
#[allow(dead_code)]
pub mod queue;
