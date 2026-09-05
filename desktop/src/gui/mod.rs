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

pub mod executor;
pub mod queue;
pub mod settings;
pub mod sink;
pub mod theme;
pub mod views;

use std::path::PathBuf;
use std::time::Duration;

use anyhow::Result;

use eframe::egui;

use executor::{DropReport, Executor};
use queue::{Job, JobKind, JobState};
use settings::Settings;
use taletrek_worker::default_cache_dir;

/// MiB constant for download-progress rendering.
const MIB: f64 = 1024.0 * 1024.0;

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
            .with_inner_size([600.0, 680.0]),
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
    /// The latest drag-drop outcome — surfaced next to the queue until the
    /// next drop replaces it (rejected files carry their reasons here).
    last_drop: Option<DropReport>,
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

    /// One queue row: the input's file name, its state (progress bar while
    /// running, output path when done, human message when failed), and its
    /// row action — Cancel while pending/running, Retry from a terminal
    /// failure/cancel.
    fn render_job(&mut self, ui: &mut egui::Ui, job: &Job) {
        let (input, voice) = match &job.kind {
            JobKind::Convert { input, voice } | JobKind::ReVoice { input, voice } => (input, voice),
        };
        ui.group(|ui| {
            ui.horizontal(|ui| {
                let name = input
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| input.display().to_string());
                ui.strong(name);
                let kind = match &job.kind {
                    JobKind::Convert { .. } => "convert",
                    JobKind::ReVoice { .. } => "re-voice",
                };
                ui.label(
                    egui::RichText::new(format!("{kind} · {voice}"))
                        .small()
                        .color(ui.visuals().weak_text_color()),
                );
                // The row action, right-aligned: cancel pending/running
                // jobs, retry failed/cancelled ones.
                ui.with_layout(
                    egui::Layout::right_to_left(egui::Align::Center),
                    |ui| match &job.state {
                        JobState::Queued | JobState::Running { .. } => {
                            if ui.button("Cancel").clicked() {
                                self.executor.cancel(job.id);
                            }
                        }
                        JobState::Failed(_) | JobState::Cancelled => {
                            if ui.button("Retry").clicked() {
                                self.executor.retry(job.id);
                            }
                        }
                        JobState::Done(_) => {}
                    },
                );
            });
            match &job.state {
                JobState::Queued => {
                    ui.label("Queued");
                }
                JobState::Running { done, total } => {
                    let frac = if *total > 0 {
                        *done as f32 / *total as f32
                    } else {
                        1.0
                    };
                    ui.add(egui::ProgressBar::new(frac).text(format!("{done}/{total} paragraphs")));
                    // Voice-model download bytes attach to the running job.
                    if self.executor.current_job() == Some(job.id) {
                        if let Some((done, total)) = self.executor.download() {
                            let line = if total > 0 {
                                format!(
                                    "Downloading voice… {:.1}/{:.1} MiB",
                                    done as f64 / MIB,
                                    total as f64 / MIB
                                )
                            } else {
                                format!("Downloading voice… {:.1} MiB", done as f64 / MIB)
                            };
                            ui.label(line);
                        }
                    }
                }
                JobState::Done(out) => {
                    ui.label(format!("Done → {}", out.display()));
                }
                JobState::Failed(message) => {
                    ui.label(
                        egui::RichText::new(format!("Failed: {message}"))
                            .small()
                            .color(egui::Color32::from_rgb(200, 80, 80)),
                    );
                    ui.label(
                        egui::RichText::new(input.display().to_string())
                            .small()
                            .color(ui.visuals().weak_text_color()),
                    );
                }
                JobState::Cancelled => {
                    ui.label("Cancelled");
                }
            }
        });
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
        egui::CentralPanel::default().show(ui, |ui| {
            ui.heading("TaleTrek");
            ui.horizontal(|ui| {
                if ui.button("Add files…").clicked() {
                    self.pick_files();
                }
                if ui.button("Add existing bundle…").clicked() {
                    self.pick_bundle();
                }
            });
            ui.label(
                egui::RichText::new("…or drop files anywhere in this window.")
                    .small()
                    .color(ui.visuals().weak_text_color()),
            );
            if let Some(report) = &self.last_drop {
                ui.label(
                    egui::RichText::new(Self::drop_summary(report))
                        .small()
                        .color(ui.visuals().weak_text_color()),
                );
            }
            ui.add_space(8.0);

            egui::CollapsingHeader::new("Settings")
                .default_open(false)
                .show(ui, |ui| {
                    if settings::render(ui, &mut self.settings) {
                        self.settings.save(ui.ctx());
                    }
                });
            ui.add_space(8.0);

            ui.heading("Voice");
            ui.label(
                egui::RichText::new("New jobs use this voice; models download on first use.")
                    .small()
                    .color(ui.visuals().weak_text_color()),
            );
            let picked =
                views::voice::render(ui, &self.settings.default_voice, self.cache_dir.as_deref());
            if let Some(id) = picked {
                self.set_default_voice(ui.ctx(), id);
            }
            ui.add_space(8.0);

            ui.heading("Queue");
            // Snapshot the rows first — the actions below need &mut self.
            let jobs: Vec<Job> = self.executor.queue().jobs().cloned().collect();
            let job_count = jobs.len();
            egui::ScrollArea::vertical().show(ui, |ui| {
                for job in &jobs {
                    self.render_job(ui, job);
                }
            });
            if job_count == 0 {
                ui.label(
                    "No files yet — drop a document to turn it into an audiobook, \
                     or add an existing bundle to re-voice it.",
                );
            }
        });
    }

    /// Graceful shutdown: join the running job thread so the output bundle
    /// is never half-written (documented behavior — see [`Executor::shutdown`]).
    fn on_exit(&mut self, _gl: Option<&eframe::glow::Context>) {
        self.executor.shutdown();
    }
}
