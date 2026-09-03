//! The GUI half of `taletrek-desktop` (effort `desktop-synth-gui`).
//!
//! T6's [`queue`] is the UI-free state machine; T7's shell (this module)
//! renders it and forwards user actions as events. [`executor`] owns the
//! queue and runs jobs on background threads; [`sink`] forwards worker
//! progress over a channel. egui types never appear outside this module —
//! `queue.rs`/`executor.rs`/`sink.rs` stay importable with zero UI
//! dependencies, so their logic is unit-testable headlessly.
//!
//! The shell is deliberately bare (T7 is the path, not the polish): a file
//! picker, the queue list with per-job progress, and the output path on
//! success. Voice choice, settings, and cancel UX arrive in T8/T9.

pub mod executor;
pub mod queue;
pub mod sink;

use std::time::Duration;

use anyhow::Result;

use eframe::egui;

use executor::Executor;
use queue::{Job, JobKind, JobState};

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
            .with_inner_size([560.0, 500.0]),
        ..Default::default()
    };
    eframe::run_native(
        "taletrek-desktop",
        options,
        Box::new(|_cc| Ok(Box::new(TaleTrekApp::new()))),
    )
    .map_err(|err| anyhow::anyhow!("opening window: {err}"))
}

/// The eframe app: an [`Executor`] plus its render surface. All state
/// changes flow through the executor (queue events); this type only renders
/// and forwards user actions.
struct TaleTrekApp {
    /// The queue owner + job thread manager.
    executor: Executor,
}

impl TaleTrekApp {
    /// A fresh app with an empty queue.
    fn new() -> Self {
        Self {
            executor: Executor::new(),
        }
    }

    /// Open the file dialog (multi-select over every format Convert
    /// accepts) and queue whatever comes back.
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
            let _ = self.executor.add_files(&paths);
        }
    }

    /// One queue row: the input's file name plus its state (progress bar
    /// while running, output path when done, message when failed).
    fn render_job(&self, ui: &mut egui::Ui, job: &Job) {
        ui.group(|ui| {
            ui.horizontal(|ui| {
                let input = match &job.kind {
                    JobKind::Convert { input, .. } | JobKind::ReVoice { input, .. } => input,
                };
                let name = input
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| input.display().to_string());
                ui.strong(name);
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
    /// the next job, and keep the frames coming while a job runs (worker
    /// events arrive off-frame). Also runs while the window is hidden if a
    /// repaint was requested — progress keeps flowing minimized.
    fn logic(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.executor.drain();
        self.executor.pump();
        if self.executor.is_busy() {
            ctx.request_repaint_after(Duration::from_millis(100));
        }
    }

    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        egui::CentralPanel::default().show(ui, |ui| {
            ui.heading("TaleTrek");
            if ui.button("Add files…").clicked() {
                self.pick_files();
            }
            ui.add_space(8.0);

            let mut job_count = 0;
            egui::ScrollArea::vertical().show(ui, |ui| {
                for job in self.executor.queue().jobs() {
                    job_count += 1;
                    self.render_job(ui, job);
                }
            });
            if job_count == 0 {
                ui.label("No files yet — add a document to turn it into an audiobook.");
            }
        });
    }

    /// Graceful shutdown: join the running job thread so the output bundle
    /// is never half-written (documented behavior — see [`Executor::shutdown`]).
    fn on_exit(&mut self, _gl: Option<&eframe::glow::Context>) {
        self.executor.shutdown();
    }
}
