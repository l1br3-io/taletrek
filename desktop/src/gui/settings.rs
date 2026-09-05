//! Persistent GUI settings (T9) + the run-tuning snapshot they resolve to.
//!
//! Three knobs survive restart via egui's native storage (eframe
//! `persistence` feature — RON under the app's storage backend), each under
//! its own key so a field added later starts at its default instead of
//! invalidating a serialized struct:
//!
//! - output directory — `None` (absent/empty) means *beside the input* (the
//!   CLI naming rule); a set directory receives every job's output file by
//!   its usual name.
//! - default voice — the picker's selection stamped onto new jobs at enqueue
//!   time; the key is T8's, so an existing persisted choice survives.
//! - synth workers — `None` means the engine default (T5's native guidance:
//!   2, per-model memory); explicit values are clamped to `>= 1`.
//! - theme — the desktop-ux-refresh identity choice (dark default); the key
//!   is `taletrek.settings.theme` (see [`crate::gui::theme`]).
//!
//! [`RunConfig`] is the settings-derived snapshot the executor's job threads
//! consume (resolved jobs count + output dir) — pure data, headless-testable.
//! [`render`] is the inline settings panel (presentational; it mutates the
//! [`Settings`] it is handed and reports whether anything changed so the
//! caller persists immediately).

use std::path::{Path, PathBuf};

use eframe::egui;

use taletrek_worker::DEFAULT_VOICE_ID;

use crate::engine::NATIVE_DEFAULT_JOBS;
use crate::gui::theme::{self, Theme};

/// egui-storage key for the persisted default voice id (T8's key, kept
/// stable so a persisted choice survives the T9 settings consolidation).
pub const VOICE_STORAGE_KEY: &str = "taletrek.default-voice";

/// egui-storage key for the output directory override (empty = beside input).
const OUTPUT_DIR_STORAGE_KEY: &str = "taletrek.settings.output-dir";

/// egui-storage key for the synth worker count (0 = engine default).
const JOBS_STORAGE_KEY: &str = "taletrek.settings.jobs";

/// The user-facing settings — what survives a restart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Settings {
    /// Where job outputs land; `None` = beside each input (the CLI rule).
    pub output_dir: Option<PathBuf>,
    /// The voice new jobs are stamped with at enqueue time.
    pub default_voice: String,
    /// Synth worker count; `None` = the engine default
    /// ([`NATIVE_DEFAULT_JOBS`], T5's per-model-memory guidance).
    pub jobs: Option<usize>,
    /// The visual theme — "Phosphor ink" dark by default, sepia by choice.
    pub theme: Theme,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            output_dir: None,
            default_voice: DEFAULT_VOICE_ID.to_string(),
            jobs: None,
            theme: Theme::default(),
        }
    }
}

impl Settings {
    /// Load from egui storage — absent keys fall back field-by-field, so a
    /// first run (or a key added later) starts at the defaults. An empty
    /// output-dir string and a zero jobs value both mean "default".
    pub fn load(ctx: &egui::Context) -> Self {
        ctx.data_mut(|data| {
            let output_dir = data
                .get_persisted(egui::Id::new(OUTPUT_DIR_STORAGE_KEY))
                .filter(|s: &String| !s.trim().is_empty())
                .map(PathBuf::from);
            let default_voice = data
                .get_persisted(egui::Id::new(VOICE_STORAGE_KEY))
                .unwrap_or_else(|| DEFAULT_VOICE_ID.to_string());
            let jobs = data
                .get_persisted(egui::Id::new(JOBS_STORAGE_KEY))
                .filter(|j: &u32| *j >= 1)
                .map(|j| j as usize);
            let raw_theme: Option<String> =
                data.get_persisted(egui::Id::new(theme::THEME_STORAGE_KEY));
            let theme = Theme::from_persisted(raw_theme.as_deref());
            Self {
                output_dir,
                default_voice,
                jobs,
                theme,
            }
        })
    }

    /// Persist every field (the encoding round-trips through [`load`]:
    /// empty string = beside-input, `0` = default jobs).
    pub fn save(&self, ctx: &egui::Context) {
        ctx.data_mut(|data| {
            let dir = self
                .output_dir
                .as_ref()
                .map_or_else(String::new, |p| p.display().to_string());
            data.insert_persisted(egui::Id::new(OUTPUT_DIR_STORAGE_KEY), dir);
            data.insert_persisted(egui::Id::new(VOICE_STORAGE_KEY), self.default_voice.clone());
            data.insert_persisted(
                egui::Id::new(JOBS_STORAGE_KEY),
                self.jobs.map_or(0u32, |j| j as u32),
            );
            data.insert_persisted(
                egui::Id::new(theme::THEME_STORAGE_KEY),
                self.theme.persist_name().to_owned(),
            );
        });
    }

    /// The run-tuning snapshot job threads consume.
    #[must_use]
    pub fn run_config(&self) -> RunConfig {
        RunConfig {
            jobs: self.jobs.unwrap_or(NATIVE_DEFAULT_JOBS),
            output_dir: self.output_dir.clone(),
        }
    }
}

/// Settings-derived tuning for one job spawn: the resolved worker count and
/// output directory the executor threads read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunConfig {
    /// Parallel synth workers within a job (clamped `>= 1` by the engine).
    pub jobs: usize,
    /// Output directory override; `None` = beside each input.
    pub output_dir: Option<PathBuf>,
}

impl Default for RunConfig {
    /// The engine default: [`NATIVE_DEFAULT_JOBS`] workers, output beside
    /// the input. Panic-free in every feature combination (the const is the
    /// resolved native default by construction).
    fn default() -> Self {
        Self {
            jobs: NATIVE_DEFAULT_JOBS,
            output_dir: None,
        }
    }
}

/// Where a job's output lands: `None` keeps `default` verbatim (beside the
/// input); `Some(dir)` keeps the default's **file name** but re-homes it in
/// `dir`. The caller creates `dir` before writing.
#[must_use]
pub fn resolve_output(default: PathBuf, output_dir: Option<&Path>) -> PathBuf {
    match output_dir {
        Some(dir) => dir.join(default.file_name().unwrap_or_default()),
        None => default,
    }
}

/// Render the inline settings panel. Mutates `settings` in place and returns
/// whether anything changed (the caller then calls [`Settings::save`]).
/// Purely presentational — no queue or executor access. The
/// `desktop-ux-refresh` restyle: muted field labels, machine-face values
/// (the path text and the worker count are machine data), hints small
/// muted — every control's behavior is unchanged.
pub fn render(ui: &mut egui::Ui, settings: &mut Settings) -> bool {
    let t = settings.theme.tokens();
    let mut changed = false;
    egui::Grid::new("settings-grid")
        .num_columns(3)
        .spacing([8.0, 4.0])
        .show(ui, |ui| {
            ui.label(egui::RichText::new("Output folder").color(t.muted));
            let mut dir_text = settings
                .output_dir
                .as_ref()
                .map_or_else(String::new, |p| p.display().to_string());
            if ui
                .add(
                    egui::TextEdit::singleline(&mut dir_text)
                        .hint_text("beside each input")
                        .font(egui::TextStyle::Monospace)
                        .desired_width(f32::INFINITY),
                )
                .changed()
            {
                let trimmed = dir_text.trim();
                settings.output_dir = (!trimmed.is_empty()).then(|| PathBuf::from(trimmed));
                changed = true;
            }
            if ui.button("Browse…").clicked() {
                if let Some(dir) = rfd::FileDialog::new().pick_folder() {
                    settings.output_dir = Some(dir);
                    changed = true;
                }
            }
            if settings.output_dir.is_some() && ui.button("Beside input").clicked() {
                settings.output_dir = None;
                changed = true;
            }
            ui.end_row();

            ui.label(egui::RichText::new("Synth workers").color(t.muted));
            let mut jobs = settings.jobs.unwrap_or(NATIVE_DEFAULT_JOBS) as i32;
            // The count is a machine value — render it in the machine face.
            ui.style_mut().drag_value_text_style = egui::TextStyle::Monospace;
            let response = ui.add(egui::DragValue::new(&mut jobs).range(1..=16));
            let hint = if settings.jobs.is_none() {
                format!("default: {NATIVE_DEFAULT_JOBS}")
            } else {
                "explicit".to_string()
            };
            ui.label(egui::RichText::new(hint).small().color(t.muted));
            if response.changed() {
                settings.jobs = Some(jobs.max(1) as usize);
                changed = true;
            }
            if settings.jobs.is_some() && ui.button("Default").clicked() {
                settings.jobs = None;
                changed = true;
            }
            ui.end_row();
        });
    changed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_beside_input_default_voice_native_jobs_and_dark() {
        let s = Settings::default();
        assert_eq!(s.output_dir, None);
        assert_eq!(s.default_voice, DEFAULT_VOICE_ID);
        assert_eq!(s.jobs, None);
        assert_eq!(s.theme, Theme::Dark);
    }

    #[test]
    fn save_then_load_round_trips_every_field() {
        let ctx = egui::Context::default();
        let settings = Settings {
            output_dir: Some(PathBuf::from("/tmp/audiobooks")),
            default_voice: "en_GB-cori-medium".to_string(),
            jobs: Some(4),
            theme: Theme::Sepia,
        };
        settings.save(&ctx);

        assert_eq!(Settings::load(&ctx), settings);
    }

    #[test]
    fn load_treats_empty_dir_and_zero_jobs_as_the_defaults() {
        // The persistence encoding reserves empty/0 for "default" — loading
        // raw values that say so must yield None, not Some("") or Some(0).
        let ctx = egui::Context::default();
        ctx.data_mut(|data| {
            data.insert_persisted(egui::Id::new(OUTPUT_DIR_STORAGE_KEY), String::from("  "));
            data.insert_persisted(egui::Id::new(JOBS_STORAGE_KEY), 0u32);
        });

        let loaded = Settings::load(&ctx);
        assert_eq!(loaded.output_dir, None);
        assert_eq!(loaded.jobs, None);
    }

    #[test]
    fn run_config_resolves_the_job_default_and_passes_explicit_values_through() {
        let default = Settings::default().run_config();
        assert_eq!(default, RunConfig::default());
        assert_eq!(default.jobs, NATIVE_DEFAULT_JOBS);
        assert_eq!(default.output_dir, None);

        let explicit = Settings {
            output_dir: Some(PathBuf::from("/out")),
            default_voice: DEFAULT_VOICE_ID.to_string(),
            jobs: Some(6),
            theme: Theme::Dark,
        }
        .run_config();
        assert_eq!(explicit.jobs, 6);
        assert_eq!(explicit.output_dir, Some(PathBuf::from("/out")));
    }

    #[test]
    fn resolve_output_keeps_the_default_when_unset_and_rehomes_the_name_when_set() {
        let default = PathBuf::from("/books/fable.synth.taletrek");
        assert_eq!(
            resolve_output(default.clone(), None),
            default,
            "unset = verbatim beside-input"
        );
        assert_eq!(
            resolve_output(default, Some(Path::new("/audiobooks"))),
            PathBuf::from("/audiobooks/fable.synth.taletrek"),
            "set = same file name inside the configured dir"
        );
    }

    #[test]
    fn render_paints_under_both_themes_without_reporting_a_stray_change() {
        for theme in [Theme::Dark, Theme::Sepia] {
            let ctx = egui::Context::default();
            theme::apply(&ctx, theme);

            // Both control states paint: an explicit output dir + jobs
            // (the "Beside input"/"Default" buttons show) and the defaults.
            for jobs in [None, Some(3)] {
                let mut settings = Settings {
                    theme,
                    jobs,
                    ..Settings::default()
                };
                settings.output_dir = (jobs.is_some()).then(|| PathBuf::from("/tmp/audiobooks"));
                let before = settings.clone();
                let mut changed = false;
                let _ = ctx.run_ui(egui::RawInput::default(), |ui| {
                    egui::CentralPanel::default().show(ui, |ui| {
                        ui.set_max_width(300.0);
                        changed = render(ui, &mut settings);
                    });
                });
                assert!(
                    !changed,
                    "{theme:?} jobs={jobs:?}: no input headless — render must not report a change"
                );
                assert_eq!(
                    settings, before,
                    "render must not mutate on a paint-only pass"
                );
            }
        }
        // Painting every control state under the real theme/fonts without
        // panicking is the assertion — egui aborts on layout/font misuse.
    }
}
