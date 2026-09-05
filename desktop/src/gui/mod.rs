//! The GUI half of `taletrek-desktop` (effort `desktop-synth-gui`).
//!
//! T6's [`queue`] is the UI-free state machine; the shell (this module)
//! renders it and forwards user actions as events. [`executor`] owns the
//! queue and runs jobs on background threads; [`sink`] forwards worker
//! progress over a channel. egui types never appear outside this module —
//! `queue.rs`/`executor.rs`/`sink.rs` stay importable with zero UI
//! dependencies, so their logic is unit-testable headlessly.
//!
//! T8 added voice as a first-class concern: the [`views::voice`] picker
//! (curated catalog, cached flags) backed by the persisted default voice,
//! and the second queue action — re-voice an existing `.taletrek` via
//! [`Executor::add_bundles`]. T9 rounds it into a resilient utility:
//! persistent [`settings`] (output dir, default voice, workers), cooperative
//! cancel + retry on every queue row, typed failures surfaced as human
//! sentences, and drag-drop as the primary add path (the dialogs stay as
//! fallback).
//!
//! # Shell regions (`desktop-ux-refresh`)
//!
//! The window decomposes into panels that encode the workflow (input →
//! voice → output); `ui` shows them in dependency order — top bar (brand +
//! side-panel toggle), prompt strip (the add path: dialogs, drop hint,
//! drop-summary line), bottom status line (read-only [`views::status`]
//! fold), right side panel (voice picker + settings — everything that
//! *configures* jobs), and finally the central panel, which is queue-only
//! (job rows in one scroll + the empty-state label).

pub mod executor;
pub mod queue;
pub mod settings;
pub mod sink;
pub mod theme;
pub mod views;

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::Result;

use eframe::egui;

use executor::{DropReport, Executor};
use queue::{Job, JobKind, JobState};
use settings::Settings;
use taletrek_worker::default_cache_dir;

/// MiB constant for download-progress rendering.
const MIB: f64 = 1024.0 * 1024.0;

/// Longest job-card title in characters before an ellipsis truncates it —
/// keeps every card one readable row at any window size (the spec's
/// "no blown-out cards").
const TITLE_MAX_CHARS: usize = 36;

/// Open the TaleTrek window (bare invocation and the `gui` subcommand both
/// land here). Blocks until the window closes; a job still running at close
/// is joined (see [`Executor::shutdown`]).
///
/// The renderer defaults to wgpu (Vulkan/GL); `TALETREK_RENDERER=glow`
/// selects the GLX/glow fallback for environments without Vulkan
/// (Xvfb, VMs, some remote setups).
///
/// # Errors
/// `anyhow` error when the window/native runtime fails to open (no display,
/// GL context failure, …).
pub fn run() -> Result<()> {
    let renderer = match std::env::var("TALETREK_RENDERER").as_deref() {
        Ok("glow") => eframe::Renderer::Glow,
        _ => eframe::Renderer::Wgpu,
    };
    let options = eframe::NativeOptions {
        renderer,
        viewport: egui::ViewportBuilder::default()
            .with_title("TaleTrek")
            .with_inner_size([780.0, 720.0]),
        ..Default::default()
    };
    eframe::run_native(
        "taletrek-desktop",
        options,
        Box::new(|cc| Ok(Box::new(TaleTrekApp::new(cc)))),
    )
    .map_err(|err| anyhow::anyhow!("opening window: {err}"))
}

/// The eframe app: an [`Executor`] plus its render surface. All state
/// changes flow through the executor (queue events); this type only renders
/// and forwards user actions — plus the [`Settings`] (output dir, default
/// voice, workers) that enqueueing and job spawning read.
struct TaleTrekApp {
    /// The queue owner + job thread manager.
    executor: Executor,
    /// Persistent settings (egui storage) — the picker's default voice,
    /// the output directory override, the worker count.
    settings: Settings,
    /// The platform voice cache dir (for the picker's "downloaded" flags);
    /// `None` when no cache home is discoverable.
    cache_dir: Option<PathBuf>,
    /// The latest drag-drop outcome — surfaced under the prompt strip until
    /// the next drop replaces it (rejected files carry their reasons here).
    last_drop: Option<DropReport>,
    /// Whether the right side panel (voice picker + settings) is showing.
    panel_open: bool,
}

impl TaleTrekApp {
    /// A fresh app: persisted settings (first run → defaults) and an empty
    /// queue. The persisted theme is installed before the first frame, so
    /// the window never flashes stock egui.
    fn new(cc: &eframe::CreationContext<'_>) -> Self {
        let settings = Settings::load(&cc.egui_ctx);
        theme::apply(&cc.egui_ctx, settings.theme);
        Self {
            executor: Executor::new(),
            settings,
            cache_dir: default_cache_dir(),
            last_drop: None,
            panel_open: false,
        }
    }

    /// Set the default voice and persist every setting for the next run.
    fn set_default_voice(&mut self, ctx: &egui::Context, id: String) {
        self.settings.default_voice = id;
        self.settings.save(ctx);
    }

    /// Enqueue this frame's dropped files (the primary add path, T9):
    /// classify → Convert/ReVoice, dedup by path, reject unsupported
    /// formats with a visible reason. egui reports the drop on the frame it
    /// arrives; the queue-path dedup makes that idempotent regardless.
    fn handle_drops(&mut self, ctx: &egui::Context) {
        let dropped: Vec<PathBuf> = ctx.input(|input| {
            input
                .raw
                .dropped_files
                .iter()
                .filter_map(|file| file.path.clone())
                .collect()
        });
        if dropped.is_empty() {
            return;
        }
        let voice = self.settings.default_voice.clone();
        self.last_drop = Some(self.executor.add_dropped(&dropped, &voice));
    }

    /// The one-line summary of the latest drop — counts plus every
    /// rejection reason (the "visible reason" contract).
    fn drop_summary(report: &DropReport) -> String {
        let mut parts = vec![format!("Added {} file(s)", report.enqueued)];
        parts.extend(
            report
                .duplicates
                .iter()
                .map(|p| format!("already queued: {}", p.display())),
        );
        parts.extend(
            report
                .rejected
                .iter()
                .map(|(p, reason)| format!("rejected {} — {reason}", p.display())),
        );
        parts.join(" · ")
    }

    /// The card title for a job's input: its file name (the only serif
    /// text in the chrome), or the full display path when the path has no
    /// file name (root, `..`). Truncated to [`TITLE_MAX_CHARS`]
    /// characters with a single ellipsis so no card row blows out.
    fn job_title(input: &Path) -> String {
        let raw = input
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| input.display().to_string());
        if raw.chars().count() <= TITLE_MAX_CHARS {
            raw
        } else {
            raw.chars()
                .take(TITLE_MAX_CHARS - 1)
                .chain(std::iter::once('…'))
                .collect()
        }
    }

    /// The card's meta line: the job kind and its voice
    /// (`convert · en_US-amy-medium`).
    fn job_meta(kind: &JobKind) -> String {
        match kind {
            JobKind::Convert { voice, .. } => format!("convert · {voice}"),
            JobKind::ReVoice { voice, .. } => format!("re-voice · {voice}"),
        }
    }

    /// Open the file dialog (multi-select over every format Convert
    /// accepts) and queue whatever comes back as Convert jobs under the
    /// current default voice.
    fn pick_files(&mut self) {
        let picked = rfd::FileDialog::new()
            .add_filter(
                "Books & documents",
                &[
                    "taletrek", "epub", "txt", "html", "htm", "md", "markdown", "docx", "pdf",
                ],
            )
            .pick_files();
        if let Some(paths) = picked {
            let voice = self.settings.default_voice.clone();
            let _ = self.executor.add_files(&paths, &voice);
        }
    }

    /// Open the `.taletrek` picker ("Add existing bundle…") and queue
    /// whatever comes back as ReVoice jobs under the current default voice
    /// — a full-bundle voice swap, output written as
    /// `<stem>.<voice>.taletrek`.
    fn pick_bundle(&mut self) {
        let picked = rfd::FileDialog::new()
            .add_filter("TaleTrek bundles", &["taletrek"])
            .pick_files();
        if let Some(paths) = picked {
            let voice = self.settings.default_voice.clone();
            let _ = self.executor.add_bundles(&paths, &voice);
        }
    }

    /// The top bar: the `❯~` brand mark and the side-panel toggle — the
    /// window's persistent identity strip.
    fn top_bar(&mut self, ui: &mut egui::Ui) {
        egui::Panel::top("top-bar").show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.strong("❯~ TaleTrek");
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if ui.button("⚙").on_hover_text("Voice & settings").clicked() {
                        self.panel_open = !self.panel_open;
                    }
                });
            });
        });
    }

    /// The prompt strip: the add path — both dialogs, the drop hint, and
    /// the latest drop's summary line (reject reasons included, so drop
    /// feedback lives where the drop happened).
    fn prompt_strip(&mut self, ui: &mut egui::Ui) {
        egui::Panel::top("prompt-strip").show(ui, |ui| {
            ui.horizontal(|ui| {
                if ui.button("Add files…").clicked() {
                    self.pick_files();
                }
                if ui.button("Add existing bundle…").clicked() {
                    self.pick_bundle();
                }
                ui.label(
                    egui::RichText::new("…or drop files anywhere in this window.")
                        .small()
                        .color(ui.visuals().weak_text_color()),
                );
            });
            if let Some(report) = &self.last_drop {
                ui.label(
                    egui::RichText::new(Self::drop_summary(report))
                        .small()
                        .color(ui.visuals().weak_text_color()),
                );
            }
        });
    }

    /// The bottom status line: `❯ <voice> · <quality>` left, live queue
    /// and worker counts right — a read-only fold resolved by
    /// [`views::status`] from queue states plus settings.
    fn status_bar(&mut self, ui: &mut egui::Ui) {
        egui::Panel::bottom("status-bar").show(ui, |ui| {
            let states: Vec<&JobState> =
                self.executor.queue().jobs().map(|job| &job.state).collect();
            let line = views::status::status_line(
                &self.settings.default_voice,
                states,
                self.settings.run_config().jobs,
            );
            views::status::render(ui, &line);
        });
    }

    /// The toggleable right side panel: the voice picker and the settings
    /// collapse — everything that configures jobs rather than being one.
    fn side_panel(&mut self, ui: &mut egui::Ui) {
        egui::Panel::right("side-panel")
            .default_size(300.0)
            .show(ui, |ui| {
                ui.heading("Voice");
                ui.label(
                    egui::RichText::new("New jobs use this voice; models download on first use.")
                        .small()
                        .color(ui.visuals().weak_text_color()),
                );
                let picked = views::voice::render(
                    ui,
                    &self.settings.default_voice,
                    self.cache_dir.as_deref(),
                );
                if let Some(id) = picked {
                    self.set_default_voice(ui.ctx(), id);
                }
                ui.add_space(8.0);

                egui::CollapsingHeader::new("Settings")
                    .default_open(false)
                    .show(ui, |ui| {
                        if settings::render(ui, &mut self.settings) {
                            self.settings.save(ui.ctx());
                        }
                    });
            });
    }

    /// The central queue: every job's row in one scroll, plus the
    /// empty-state label when there are none — queue-only, by the shell's
    /// region split.
    fn queue_panel(&mut self, ui: &mut egui::Ui) {
        egui::CentralPanel::default().show(ui, |ui| {
            // Snapshot the rows first — the actions below need &mut self.
            let jobs: Vec<Job> = self.executor.queue().jobs().cloned().collect();
            egui::ScrollArea::vertical()
                .auto_shrink(false)
                .show(ui, |ui| {
                    if jobs.is_empty() {
                        ui.label(
                            "No files yet — drop a document to turn it into an audiobook, \
                             or add an existing bundle to re-voice it.",
                        );
                    }
                    for job in &jobs {
                        self.render_job(ui, job);
                    }
                });
        });
    }

    /// One queue row as the spec's job card: a framed surface card whose
    /// title row pairs the input's serif file name (XCharter Bold — the
    /// one serif usage in the chrome) with the small mono meta line at
    /// the right, and whose state row carries the state treatment with
    /// the row action right-aligned — accent progress while running,
    /// success path when done, danger message + muted input path when
    /// failed, muted label when cancelled/queued.
    fn render_job(&mut self, ui: &mut egui::Ui, job: &Job) {
        let input = match &job.kind {
            JobKind::Convert { input, .. } | JobKind::ReVoice { input, .. } => input,
        };
        let t = self.settings.theme.tokens();
        // Voice-model download bytes attach to the running job — resolved
        // before the card so the frame's closures only borrow the string.
        let download = if matches!(job.state, JobState::Running { .. })
            && self.executor.current_job() == Some(job.id)
        {
            self.executor.download().map(|(done, total)| {
                if total > 0 {
                    format!(
                        "Downloading voice… {:.1}/{:.1} MiB",
                        done as f64 / MIB,
                        total as f64 / MIB
                    )
                } else {
                    format!("Downloading voice… {:.1} MiB", done as f64 / MIB)
                }
            })
        } else {
            None
        };

        theme::card_frame(t).show(ui, |ui| {
            // Title row: serif file name left, mono meta right.
            ui.horizontal(|ui| {
                ui.label(
                    egui::RichText::new(Self::job_title(input))
                        .font(egui::FontId::new(18.0, theme::story_bold_family())),
                );
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.label(
                        egui::RichText::new(Self::job_meta(&job.kind))
                            .small()
                            .color(t.muted),
                    );
                });
            });

            // State row: the state treatment with its action right-aligned.
            match &job.state {
                JobState::Queued => {
                    ui.horizontal(|ui| {
                        ui.label(egui::RichText::new("Queued").color(t.muted));
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            if ui.button("Cancel").clicked() {
                                self.executor.cancel(job.id);
                            }
                        });
                    });
                }
                JobState::Running { done, total } => {
                    ui.horizontal(|ui| {
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            if ui.button("Cancel").clicked() {
                                self.executor.cancel(job.id);
                            }
                            // The styled bar's track (extreme_bg) and text
                            // (selection stroke) don't follow tokens — the
                            // theme pins both to colors that vanish on a
                            // surface card. Override locally: elevated
                            // track, fg text, accent fill.
                            ui.style_mut().visuals.extreme_bg_color = t.elevated;
                            ui.style_mut().visuals.override_text_color = Some(t.fg);
                            let frac = if *total > 0 {
                                *done as f32 / *total as f32
                            } else {
                                1.0
                            };
                            ui.add(
                                egui::ProgressBar::new(frac)
                                    .text(format!("{done}/{total} paragraphs"))
                                    .fill(t.accent)
                                    .corner_radius(3),
                            );
                        });
                    });
                    if let Some(line) = download {
                        ui.label(egui::RichText::new(line).small().color(t.muted));
                    }
                }
                JobState::Done(out) => {
                    ui.label(
                        egui::RichText::new(format!("Done → {}", out.display())).color(t.success),
                    );
                }
                JobState::Failed(message) => {
                    ui.horizontal(|ui| {
                        ui.label(
                            egui::RichText::new(format!("Failed: {message}"))
                                .small()
                                .color(t.danger),
                        );
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            if ui.button("Retry").clicked() {
                                self.executor.retry(job.id);
                            }
                        });
                    });
                    ui.label(
                        egui::RichText::new(input.display().to_string())
                            .small()
                            .color(t.muted),
                    );
                }
                JobState::Cancelled => {
                    ui.horizontal(|ui| {
                        ui.label(egui::RichText::new("Cancelled").color(t.muted));
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            if ui.button("Retry").clicked() {
                                self.executor.retry(job.id);
                            }
                        });
                    });
                }
            }
        });
        ui.add_space(6.0);
    }
}

impl eframe::App for TaleTrekApp {
    /// The non-painting half of each frame: drain worker messages, admit
    /// dropped files, start the next job, and keep the frames coming while
    /// a job runs (worker events arrive off-frame). Also runs while the
    /// window is hidden if a repaint was requested — progress keeps flowing
    /// minimized.
    fn logic(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.executor.drain();
        self.handle_drops(ctx);
        let run = self.settings.run_config();
        self.executor.pump(&run);
        if self.executor.is_busy() {
            ctx.request_repaint_after(Duration::from_millis(100));
        }
    }

    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        // Panel order is layout order: top bar, then prompt strip below it,
        // status line at the bottom, side panel beside what remains, and
        // the central queue last inside whatever is left.
        self.top_bar(ui);
        self.prompt_strip(ui);
        self.status_bar(ui);
        if self.panel_open {
            self.side_panel(ui);
        }
        self.queue_panel(ui);
    }

    /// Graceful shutdown: join the running job thread so the output bundle
    /// is never half-written (documented behavior — see [`Executor::shutdown`]).
    fn on_exit(&mut self, _gl: Option<&eframe::glow::Context>) {
        self.executor.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn job_title_uses_the_file_name() {
        let title = TaleTrekApp::job_title(Path::new("/books/Fable of the Fox.epub"));
        assert_eq!(title, "Fable of the Fox.epub");
    }

    #[test]
    fn job_title_truncates_long_names_with_one_ellipsis() {
        let exactly = "a".repeat(TITLE_MAX_CHARS);
        assert_eq!(
            TaleTrekApp::job_title(Path::new(&exactly)),
            exactly,
            "a title at the budget passes through untouched"
        );

        let long = format!("{}.epub", "b".repeat(TITLE_MAX_CHARS));
        let title = TaleTrekApp::job_title(Path::new(&long));
        assert_eq!(title.chars().count(), TITLE_MAX_CHARS);
        assert!(title.ends_with('…'));
        assert!(title.starts_with(&"b".repeat(TITLE_MAX_CHARS - 1)));
    }

    #[test]
    fn job_title_truncates_by_characters_not_bytes() {
        let long = "日".repeat(TITLE_MAX_CHARS + 10);
        let title = TaleTrekApp::job_title(Path::new(&long));
        assert_eq!(title.chars().count(), TITLE_MAX_CHARS);
        assert!(title.ends_with('…'));
    }

    #[test]
    fn job_title_falls_back_to_the_display_path_without_a_file_name() {
        assert_eq!(TaleTrekApp::job_title(Path::new("/")), "/");
        assert_eq!(TaleTrekApp::job_title(Path::new("..")), "..");
        assert_eq!(TaleTrekApp::job_title(Path::new("/books/..")), "/books/..");
    }

    #[test]
    fn job_meta_names_the_kind_and_voice() {
        let convert = JobKind::Convert {
            input: PathBuf::from("a.epub"),
            voice: "en_US-amy-medium".to_owned(),
        };
        assert_eq!(
            TaleTrekApp::job_meta(&convert),
            "convert · en_US-amy-medium"
        );

        let revoice = JobKind::ReVoice {
            input: PathBuf::from("a.taletrek"),
            voice: "v".to_owned(),
        };
        assert_eq!(TaleTrekApp::job_meta(&revoice), "re-voice · v");
    }

    #[test]
    fn render_job_paints_every_state_under_both_themes() {
        use queue::JobId;

        let convert = |name: String| JobKind::Convert {
            input: PathBuf::from(format!("/books/{name}")),
            voice: "en_US-amy-medium".to_owned(),
        };
        let jobs = vec![
            Job {
                id: JobId::for_test(0),
                kind: convert("Fable of the Fox.epub".to_owned()),
                state: JobState::Queued,
            },
            Job {
                id: JobId::for_test(1),
                kind: convert("Fable of the Fox.epub".to_owned()),
                state: JobState::Running {
                    done: 12,
                    total: 19,
                },
            },
            Job {
                id: JobId::for_test(2),
                kind: convert("Fable of the Fox.epub".to_owned()),
                state: JobState::Done(PathBuf::from("/out/Fable of the Fox.taletrek")),
            },
            Job {
                id: JobId::for_test(3),
                kind: convert("Fable of the Fox.epub".to_owned()),
                state: JobState::Failed("could not parse the document".to_owned()),
            },
            Job {
                id: JobId::for_test(4),
                kind: convert("Fable of the Fox.epub".to_owned()),
                state: JobState::Cancelled,
            },
            // A blown-out title exercises the truncation path end to end.
            Job {
                id: JobId::for_test(5),
                kind: convert(format!("{}.epub", "x".repeat(120))),
                state: JobState::Queued,
            },
        ];

        for theme in [theme::Theme::Dark, theme::Theme::Sepia] {
            let ctx = egui::Context::default();
            theme::apply(&ctx, theme);
            let mut settings = Settings::load(&ctx);
            settings.theme = theme;
            let mut app = TaleTrekApp {
                executor: Executor::new(),
                settings,
                cache_dir: None,
                last_drop: None,
                panel_open: false,
            };
            let _ = ctx.run_ui(egui::RawInput::default(), |ctx| {
                egui::CentralPanel::default().show(ctx, |ui| {
                    for job in &jobs {
                        app.render_job(ui, job);
                    }
                });
            });
        }
        // Rendering every card under the real theme/fonts without panicking
        // is the assertion — egui aborts on layout/font misuse.
    }
}
