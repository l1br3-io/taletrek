//! The GUI half of `taletrek-desktop` (effort `desktop-synth-gui`).
//!
//! T6's [`queue`] is the UI-free state machine; the shell (this module)
//! renders it and forwards user actions as events. [`executor`] owns the
//! queue and runs jobs on background threads; [`sink`] forwards worker
//! progress over a channel. egui types never appear outside this module —
//! `queue.rs`/`executor.rs`/`sink.rs` stay importable with zero UI
//! dependencies, so their logic is unit-testable headlessly.
//!
//! T8 adds voice as a first-class concern: the [`views::voice`] picker
//! (curated catalog, cached flags) backed by a persisted default voice, and
//! the second queue action — re-voice an existing `.taletrek` via
//! [`Executor::add_bundles`]. Settings and failure/cancel UX arrive in T9.

pub mod executor;
pub mod queue;
pub mod sink;
pub mod views;

use std::path::PathBuf;
use std::time::Duration;

use anyhow::Result;

use eframe::egui;

use executor::Executor;
use queue::{Job, JobKind, JobState};
use taletrek_worker::{default_cache_dir, DEFAULT_VOICE_ID};

/// egui-storage key for the persisted default voice id. Absent (first run)
/// → [`DEFAULT_VOICE_ID`]; written whenever the picker selection changes.
const VOICE_STORAGE_KEY: &str = "taletrek.default-voice";

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
/// and forwards user actions — plus the persisted default-voice selection
/// the picker writes and enqueueing reads.
struct TaleTrekApp {
    /// The queue owner + job thread manager.
    executor: Executor,
    /// The default voice new jobs are stamped with (the picker's current
    /// selection; each job snapshots it at enqueue time as its per-job
    /// override). Persisted via egui storage ([`VOICE_STORAGE_KEY`]).
    default_voice: String,
    /// The platform voice cache dir (for the picker's "downloaded" flags);
    /// `None` when no cache home is discoverable.
    cache_dir: Option<PathBuf>,
}

impl TaleTrekApp {
    /// A fresh app: the persisted default voice (first run →
    /// [`DEFAULT_VOICE_ID`]) and an empty queue.
    fn new(cc: &eframe::CreationContext<'_>) -> Self {
        let default_voice = cc
            .egui_ctx
            .data_mut(|data| data.get_persisted(egui::Id::new(VOICE_STORAGE_KEY)))
            .unwrap_or_else(|| DEFAULT_VOICE_ID.to_string());
        Self {
            executor: Executor::new(),
            default_voice,
            cache_dir: default_cache_dir(),
        }
    }

    /// Set the default voice and persist it for the next run.
    fn set_default_voice(&mut self, ctx: &egui::Context, id: String) {
        ctx.data_mut(|data| data.insert_persisted(egui::Id::new(VOICE_STORAGE_KEY), id.clone()));
        self.default_voice = id;
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
            let _ = self.executor.add_files(&paths, &self.default_voice);
        }
    }

    /// Open the `.taletrek` picker ("Add existing bundle…") and queue
    /// whatever comes back as ReVoice jobs under the current default voice
    /// — a full-bundle voice swap, output written beside the input as
    /// `<stem>.<voice>.taletrek`.
    fn pick_bundle(&mut self) {
        let picked = rfd::FileDialog::new()
            .add_filter("TaleTrek bundles", &["taletrek"])
            .pick_files();
        if let Some(paths) = picked {
            let _ = self.executor.add_bundles(&paths, &self.default_voice);
        }
    }

    /// One queue row: the input's file name plus its state (progress bar
    /// while running, output path when done, message when failed).
    fn render_job(&self, ui: &mut egui::Ui, job: &Job) {
        ui.group(|ui| {
            ui.horizontal(|ui| {
                let (input, voice) = match &job.kind {
                    JobKind::Convert { input, voice } | JobKind::ReVoice { input, voice } => {
                        (input, voice)
                    }
                };
                let name = input
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| input.display().to_string());
                ui.strong(name);
                // The job's voice snapshot (its per-job override) + kind.
                let kind = match &job.kind {
                    JobKind::Convert { .. } => "convert",
                    JobKind::ReVoice { .. } => "re-voice",
                };
                ui.label(
                    egui::RichText::new(format!("{kind} · {voice}"))
                        .small()
                        .color(ui.visuals().weak_text_color()),
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
            ui.horizontal(|ui| {
                if ui.button("Add files…").clicked() {
                    self.pick_files();
                }
                if ui.button("Add existing bundle…").clicked() {
                    self.pick_bundle();
                }
            });
            ui.add_space(8.0);

            ui.heading("Voice");
            ui.label(
                egui::RichText::new("New jobs use this voice; models download on first use.")
                    .small()
                    .color(ui.visuals().weak_text_color()),
            );
            if let Some(id) =
                views::voice::render(ui, &self.default_voice, self.cache_dir.as_deref())
            {
                self.set_default_voice(ui.ctx(), id);
            }
            ui.add_space(8.0);

            ui.heading("Queue");
            let mut job_count = 0;
            egui::ScrollArea::vertical().show(ui, |ui| {
                for job in self.executor.queue().jobs() {
                    job_count += 1;
                    self.render_job(ui, job);
                }
            });
            if job_count == 0 {
                ui.label(
                    "No files yet — add a document to turn it into an audiobook, \
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
