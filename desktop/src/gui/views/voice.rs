//! The voice picker (T8): the curated catalog as a selectable list.
//!
//! Renders [`CURATED_VOICES`] (id, name, quality, size) with the current
//! default marked by the radio selection and already-cached voices flagged.
//! Selecting a voice does **not** download it — the model is acquired
//! lazily by the first job that uses it (the worker's `resolve_voice`
//! inside the job thread, download progress shown on that job's row), so
//! the picker stays a pure choice and the network stays off the UI thread.
//!
//! The pure helpers ([`is_voice_cached`], [`size_label`]) are headless-
//! testable; only [`render`] touches egui.

use std::path::Path;

use eframe::egui;

use taletrek_worker::{VoiceQuality, CURATED_VOICES};

/// Whether a voice's model pair is already in the local cache — both the
/// `.onnx` and its `.json` config must be present, mirroring the worker's
/// cache-hit short-circuit (`resolve_voice` treats a partial pair as a miss
/// and re-downloads). Cache layout: `<cache_dir>/<id>.onnx` +
/// `<cache_dir>/<id>.json`.
pub fn is_voice_cached(cache_dir: &Path, id: &str) -> bool {
    cache_dir.join(format!("{id}.onnx")).is_file() && cache_dir.join(format!("{id}.json")).is_file()
}

/// Approximate model size for the catalog list, in whole MiB — the same
/// unit the download-progress line uses, so the list and the progress agree.
pub fn size_label(bytes: u64) -> String {
    format!("~{} MiB", bytes / (1024 * 1024))
}

/// The quality tier as a lowercase label — the catalog list and the
/// status line share this rendering.
pub(crate) fn quality_label(quality: VoiceQuality) -> &'static str {
    match quality {
        VoiceQuality::Low => "low",
        VoiceQuality::Medium => "medium",
        VoiceQuality::High => "high",
    }
}

/// Render the catalog. `selected` is the current default voice id (marked
/// by the radio); `cache_dir` flags already-downloaded voices (`None` = no
/// discoverable cache dir — nothing is flagged). Returns the id the user
/// newly picked, if any — the caller persists it as the default and stamps
/// it onto subsequently enqueued jobs.
pub fn render(ui: &mut egui::Ui, selected: &str, cache_dir: Option<&Path>) -> Option<String> {
    let mut picked = None;
    egui::Grid::new("voice-catalog")
        .num_columns(5)
        .striped(true)
        .min_col_width(12.0)
        .show(ui, |ui| {
            ui.strong("Voice");
            ui.strong("Id");
            ui.strong("Quality");
            ui.strong("Size");
            ui.strong("Status");
            ui.end_row();
            for voice in CURATED_VOICES {
                let is_selected = voice.id == selected;
                if ui.radio(is_selected, voice.name).clicked() && !is_selected {
                    picked = Some(voice.id.to_string());
                }
                ui.label(
                    egui::RichText::new(voice.id)
                        .small()
                        .monospace()
                        .color(ui.visuals().weak_text_color()),
                );
                ui.label(quality_label(voice.quality));
                ui.label(size_label(voice.size_bytes));
                let status = if cache_dir.is_some_and(|dir| is_voice_cached(dir, voice.id)) {
                    "downloaded"
                } else {
                    ""
                };
                ui.label(
                    egui::RichText::new(status)
                        .small()
                        .color(ui.visuals().weak_text_color()),
                );
                ui.end_row();
            }
        });
    picked
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(dir: &Path, name: &str) {
        std::fs::write(dir.join(name), b"bytes").unwrap();
    }

    #[test]
    fn cached_requires_both_onnx_and_json() {
        let dir = tempfile::tempdir().unwrap();
        let id = "en_US-hfc_female-medium";

        // Empty cache — not cached.
        assert!(!is_voice_cached(dir.path(), id));

        // Only the model — still a miss (partial pairs re-download).
        touch(dir.path(), &format!("{id}.onnx"));
        assert!(!is_voice_cached(dir.path(), id));

        // Both files — a hit.
        touch(dir.path(), &format!("{id}.json"));
        assert!(is_voice_cached(dir.path(), id));
    }

    #[test]
    fn cache_check_uses_the_worker_layout_per_id() {
        let dir = tempfile::tempdir().unwrap();
        touch(dir.path(), "en_GB-alan-medium.onnx");
        touch(dir.path(), "en_GB-alan-medium.json");

        assert!(is_voice_cached(dir.path(), "en_GB-alan-medium"));
        assert!(
            !is_voice_cached(dir.path(), "en_US-ryan-medium"),
            "other voices stay unflagged"
        );
    }

    #[test]
    fn size_label_uses_whole_mib() {
        assert_eq!(size_label(0), "~0 MiB");
        assert_eq!(size_label(63_201_294), "~60 MiB");
        assert_eq!(size_label(3 * 1024 * 1024), "~3 MiB");
    }
}
