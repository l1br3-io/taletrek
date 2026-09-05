//! The bottom status line (effort `desktop-ux-refresh`): the app's quiet
//! readout register — `❯ <voice> · <quality>` left, live queue + worker
//! counts right (a tmux-style echo of the prompt motif).
//!
//! Follows the views contract: [`status_line`] resolves everything it's
//! handed into pure data (headless-testable); [`render`] draws that data
//! and returns nothing. The shell owns the fold's inputs — job states
//! from [`Queue::jobs`](crate::gui::queue::Queue::jobs), voice + resolved
//! worker count from [`Settings`](crate::gui::settings::Settings) — so no
//! queue or executor state lives here.

use eframe::egui;

use taletrek_worker::find_curated;

use super::voice::quality_label;
use crate::gui::queue::JobState;

/// The status line's resolved halves — what [`render`] draws.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusLine {
    /// `❯ <voice> · <quality>` — the default voice new jobs get.
    pub left: String,
    /// `<n> queued · <n> running · <n> workers` — live queue readout
    /// (zero-count states are omitted; the worker count always shows).
    pub right: String,
}

/// Resolve the status line (pure). `voice_id` names the default voice
/// (catalog voices render `name · quality`; anything else falls back to
/// the raw id); `states` are the queue's job states (only `Queued` and
/// `Running` count — terminal states stay in the queue list, not the
/// readout); `workers` is the resolved synth worker count.
#[must_use]
pub fn status_line<'a>(
    voice_id: &str,
    states: impl IntoIterator<Item = &'a JobState>,
    workers: usize,
) -> StatusLine {
    let left = match find_curated(voice_id) {
        Some(voice) => format!("❯ {} · {}", voice.name, quality_label(voice.quality)),
        None => format!("❯ {voice_id}"),
    };

    let (mut queued, mut running) = (0usize, 0usize);
    for state in states {
        match state {
            JobState::Queued => queued += 1,
            JobState::Running { .. } => running += 1,
            JobState::Done(_) | JobState::Failed(_) | JobState::Cancelled => {}
        }
    }
    let mut parts = Vec::new();
    if queued > 0 {
        parts.push(format!("{queued} queued"));
    }
    if running > 0 {
        parts.push(format!("{running} running"));
    }
    parts.push(format!("{workers} workers"));

    StatusLine {
        left,
        right: parts.join(" · "),
    }
}

/// Render the status line into the bottom panel: left half flush left,
/// right half flush right. Returns nothing — a read-only view.
pub fn render(ui: &mut egui::Ui, line: &StatusLine) {
    ui.horizontal(|ui| {
        ui.label(&line.left);
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            ui.label(&line.right);
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::path::PathBuf;

    use taletrek_worker::DEFAULT_VOICE_ID;

    #[test]
    fn left_half_resolves_a_catalog_voice_to_name_and_quality() {
        let line = status_line(DEFAULT_VOICE_ID, [], 4);
        assert_eq!(line.left, "❯ HFC Female · medium");

        let line = status_line("en_US-amy-medium", [], 4);
        assert_eq!(line.left, "❯ Amy · medium");
    }

    #[test]
    fn left_half_falls_back_to_the_raw_id_off_catalog() {
        let line = status_line("custom-voice", [], 4);
        assert_eq!(line.left, "❯ custom-voice");
    }

    #[test]
    fn right_half_counts_queued_and_running_and_appends_workers() {
        let states = [
            JobState::Queued,
            JobState::Queued,
            JobState::Running { done: 1, total: 3 },
            JobState::Done(PathBuf::from("out.taletrek")),
            JobState::Failed("boom".to_string()),
            JobState::Cancelled,
        ];
        let line = status_line(DEFAULT_VOICE_ID, states.iter(), 4);
        assert_eq!(line.right, "2 queued · 1 running · 4 workers");
    }

    #[test]
    fn right_half_hides_zero_state_counts_and_always_keeps_workers() {
        let line = status_line(DEFAULT_VOICE_ID, [], 2);
        assert_eq!(line.right, "2 workers");

        let running = [JobState::Running { done: 0, total: 5 }];
        let line = status_line(DEFAULT_VOICE_ID, running.iter(), 2);
        assert_eq!(line.right, "1 running · 2 workers");

        let terminal = [
            JobState::Done(PathBuf::from("a.taletrek")),
            JobState::Cancelled,
        ];
        let line = status_line(DEFAULT_VOICE_ID, terminal.iter(), 2);
        assert_eq!(line.right, "2 workers");
    }
}
