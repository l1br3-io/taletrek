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
//! `desktop-reader-page` adds a screen switch: the shell renders either
//! the converter (below) or the [`reader`] screen (an opened bundle).
//! Entry points are the **Read** action on `Done` rows and **Open
//! bundle…** in the top bar; back is a pure screen flip — the queue
//! lives in the executor, so it is intact by construction (and jobs keep
//! running while a book is open). Open failures surface as human
//! sentences in a dismissible banner ([`Self::error_banner`]).
//!
//! # Shell regions (`desktop-ux-refresh`)
//!
//! The window decomposes into panels that encode the workflow (input →
//! voice → output); `ui` shows them in dependency order — top bar (brand +
//! side-panel toggle + Open bundle…), prompt strip (the add path and the
//! window's drop target: the `❯ drop a book▊` hero with its blinking
//! cursor while the queue is empty, a compact one-line strip once it
//! isn't, plus the dialogs and the drop-summary line), bottom status line
//! (read-only [`views::status`] fold), right side panel (voice picker +
//! settings — everything that *configures* jobs), and finally the central
//! panel, which is queue-only (job rows in one scroll; the empty state's
//! guidance lives in the prompt hero, so an idle queue body is bare). On
//! the reader screen the prompt strip, status line, and queue body are
//! replaced by [`reader::view`]'s own regions (header, outline, text
//! pane, transport); the top bar and the side panel persist.

pub mod executor;
pub mod queue;
pub mod reader;
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
use reader::view::{ReaderAction, ReaderView};
use settings::Settings;
use taletrek_worker::default_cache_dir;

/// MiB constant for download-progress rendering.
const MIB: f64 = 1024.0 * 1024.0;

/// Longest job-card title in characters before an ellipsis truncates it —
/// keeps every card one readable row at any window size (the spec's
/// "no blown-out cards").
const TITLE_MAX_CHARS: usize = 36;

/// The hero cursor's blink period in seconds — the spec's 1.1 s step-end
/// cadence: on for half, off for half, jumping at the boundary (no fade).
const BLINK_PERIOD_SECS: f64 = 1.1;

/// The hero prompt line's size in pt — the strip's signature scale,
/// a step above the 18 pt serif titles.
const HERO_PT: f32 = 24.0;

/// Whether the hero's block cursor is on at `elapsed` seconds (step-end:
/// on for the first half of each [`BLINK_PERIOD_SECS`], off for the
/// second, jumping at the boundary).
fn cursor_on(elapsed: f64) -> bool {
    elapsed.rem_euclid(BLINK_PERIOD_SECS) < BLINK_PERIOD_SECS / 2.0
}

/// The delay to the cursor's next on/off toggle — what the hero requests
/// as its repaint delay, so the blink steps precisely (two wakeups per
/// period) instead of polling every frame.
fn blink_step_delay(elapsed: f64) -> Duration {
    let phase = elapsed.rem_euclid(BLINK_PERIOD_SECS);
    let to_toggle = if cursor_on(elapsed) {
        BLINK_PERIOD_SECS / 2.0 - phase
    } else {
        BLINK_PERIOD_SECS - phase
    };
    Duration::from_secs_f64(to_toggle)
}

/// One styled span of the hero prompt line.
#[derive(Debug, Clone, PartialEq, Eq)]
enum HeroSpan {
    /// The accent `❯` glyph that opens the prompt.
    Prompt,
    /// Machine-chrome words in the mono face (`drop a`).
    Machine(String),
    /// The story word in XCharter (`book`) — the story voice inside
    /// the machine.
    Story(String),
    /// The block cursor `▊`; the flag is its on/off step. Always laid
    /// out — only the color changes — so the line never shifts as it
    /// blinks.
    Cursor(bool),
}

/// The empty-queue hero, resolved pure (headless-testable): the prompt
/// line's spans in draw order, plus the muted guidance line beneath.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PromptHero {
    spans: Vec<HeroSpan>,
    guidance: String,
}

/// Resolve the hero at `elapsed` seconds (drives the cursor step).
fn hero(elapsed: f64) -> PromptHero {
    PromptHero {
        spans: vec![
            HeroSpan::Prompt,
            HeroSpan::Machine("drop a".to_owned()),
            HeroSpan::Story("book".to_owned()),
            HeroSpan::Cursor(cursor_on(elapsed)),
        ],
        guidance: "Drop a document to turn it into an audiobook, \
                   or add an existing bundle to re-voice it."
            .to_owned(),
    }
}

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

/// Which screen the shell renders. The converter is the default; the
/// reader is an opened bundle (see [`reader::view`]). Back is a pure
/// flip — queue state lives in the [`Executor`], untouched either way.
#[derive(Default)]
enum Screen {
    /// The converter: prompt strip + queue + status line.
    #[default]
    Converter,
    /// The reader: one open session's view (boxed — the view carries
    /// the playback controller and the book index; keeping the enum
    /// lean keeps every Screen-sized value cheap to move).
    Reader(Box<ReaderView>),
}

/// The eframe app: an [`Executor`] plus its render surface. All state
/// changes flow through the executor (queue events); this type only renders
/// and forwards user actions — plus the [`Settings`] (output dir, default
/// voice, workers) that enqueueing and job spawning read, and the
/// [`Screen`] it is showing.
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
    /// Which screen is rendering (converter ⇄ reader).
    screen: Screen,
    /// The latest bundle-open failure as a human sentence — surfaced in a
    /// dismissible banner until read or replaced. `None` while healthy.
    open_error: Option<String>,
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
            screen: Screen::Converter,
            open_error: None,
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

    /// Open `path` in the reader screen (the shared tail of both entry
    /// points — Read on a Done row and Open bundle…). A healthy bundle
    /// switches screens and clears any stale error; a failure stays on
    /// the current screen and surfaces the human sentence. Task 007:
    /// the store's saved position for this book rides along — the view
    /// seeds its machine there (keyed by book id, so a moved file or a
    /// re-voiced bundle resumes where it left off).
    fn open_reader(&mut self, ctx: &egui::Context, path: PathBuf) {
        match reader::session::open(&path) {
            Ok(session) => {
                self.open_error = None;
                let restore = reader::position_store::load(ctx, &session.book.book_id);
                self.screen = Screen::Reader(Box::new(ReaderView::new(session, restore)));
            }
            Err(err) => {
                self.open_error = Some(format!(
                    "Couldn't open {} — {}",
                    path.display(),
                    err.sentence()
                ));
            }
        }
    }

    /// Open the reader's `.taletrek` picker ("Open bundle…" in the top
    /// bar) and open whatever comes back for reading.
    fn pick_open_bundle(&mut self, ctx: &egui::Context) {
        let picked = rfd::FileDialog::new()
            .add_filter("TaleTrek bundles", &["taletrek"])
            .pick_file();
        if let Some(path) = picked {
            self.open_reader(ctx, path);
        }
    }

    /// The top bar: the `❯~ TaleTrek` brand (accent glyph + machine-bold
    /// word, mirroring the web nav) with the theme toggle and the
    /// side-panel toggle — the window's persistent identity strip,
    /// elevated one step off the ground (the spec's region diagram).
    fn top_bar(&mut self, ui: &mut egui::Ui) {
        let t = self.settings.theme.tokens();
        egui::Panel::top("top-bar")
            .frame(
                egui::Frame::default()
                    .fill(t.elevated)
                    .inner_margin(egui::Margin::symmetric(8, 4)),
            )
            .show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.label(egui::RichText::new("❯~").size(15.0).color(t.accent));
                    ui.label(
                        egui::RichText::new("TaleTrek")
                            .font(egui::FontId::new(15.0, theme::machine_bold_family()))
                            .color(t.fg),
                    );
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        // Right-to-left: the theme toggle takes the far
                        // corner (the spec's `[sepia ◐]`), ⚙ beside it,
                        // and the reader entry point beside that.
                        if ui
                            .button(self.settings.theme.toggle_label())
                            .on_hover_text("Switch theme")
                            .clicked()
                        {
                            self.toggle_theme(ui.ctx());
                        }
                        if ui.button("⚙").on_hover_text("Voice & settings").clicked() {
                            self.panel_open = !self.panel_open;
                        }
                        if ui
                            .button("Open bundle…")
                            .on_hover_text("Read a .taletrek file")
                            .clicked()
                        {
                            self.pick_open_bundle(ui.ctx());
                        }
                    });
                });
            });
    }

    /// Flip the theme (the top-bar toggle): swap `Settings.theme`, apply
    /// the new identity to the context in the same frame, and persist —
    /// the choice survives the next launch (dark stays the first-run
    /// default; unknown/absent stored values still resolve dark).
    fn toggle_theme(&mut self, ctx: &egui::Context) {
        self.settings.theme = self.settings.theme.other();
        theme::apply(ctx, self.settings.theme);
        self.settings.save(ctx);
    }

    /// The dismissible open-failure banner: one danger-colored sentence
    /// (the file path and reason are already joined in
    /// [`Self::open_reader`]) with a × to clear it. Rendered just under
    /// the top bar on either screen — where the user's open attempt
    /// happened.
    fn error_banner(&mut self, ui: &mut egui::Ui) {
        let Some(message) = self.open_error.clone() else {
            return;
        };
        let t = self.settings.theme.tokens();
        egui::Panel::top("error-banner")
            .frame(
                egui::Frame::default()
                    .fill(t.surface)
                    .stroke(egui::Stroke::new(1.0, t.danger))
                    .corner_radius(egui::CornerRadius::same(4))
                    .inner_margin(egui::Margin::symmetric(8, 4)),
            )
            .show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.label(egui::RichText::new(&message).small().color(t.danger));
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if ui.button("×").on_hover_text("Dismiss").clicked() {
                            self.open_error = None;
                        }
                    });
                });
            });
    }

    /// The prompt strip: the add path and the window's drop target.
    /// Empty queue: the hero prompt line ([`Self::prompt_hero`]) with
    /// the Add buttons riding it as quiet secondary actions; otherwise
    /// the compact one-line strip ([`Self::prompt_compact`]). The frame
    /// reads as the drop target — hairline at rest, accent stroke +
    /// elevated fill while files hover the window — and the latest
    /// drop's summary renders beneath in muted small text (reject
    /// reasons included, so feedback lives where the drop happened).
    fn prompt_strip(&mut self, ui: &mut egui::Ui) {
        let t = self.settings.theme.tokens();
        let empty = self.executor.queue().jobs().next().is_none();
        let dragging = ui.ctx().input(|input| !input.raw.hovered_files.is_empty());
        egui::Frame::default()
            .fill(if dragging {
                t.elevated
            } else {
                egui::Color32::TRANSPARENT
            })
            .stroke(egui::Stroke::new(
                if dragging { 1.5 } else { 1.0 },
                if dragging { t.accent } else { t.line },
            ))
            .corner_radius(egui::CornerRadius::same(4))
            .inner_margin(egui::Margin::same(8))
            .show(ui, |ui| {
                if empty {
                    self.prompt_hero(ui);
                } else {
                    self.prompt_compact(ui);
                }
                if let Some(report) = &self.last_drop {
                    ui.label(
                        egui::RichText::new(Self::drop_summary(report))
                            .small()
                            .color(t.muted),
                    );
                }
            });
    }

    /// The empty-queue hero: the signature `❯ drop a book▊` prompt line —
    /// accent `❯` and block cursor, mono machine words, the story word
    /// "book" in XCharter — with the Add buttons on the same line and
    /// the muted guidance beneath.
    fn prompt_hero(&mut self, ui: &mut egui::Ui) {
        let t = self.settings.theme.tokens();
        let hero = hero(ui.ctx().time());
        ui.horizontal(|ui| {
            for span in &hero.spans {
                match span {
                    HeroSpan::Prompt => {
                        ui.label(egui::RichText::new("❯").size(HERO_PT).color(t.accent));
                    }
                    HeroSpan::Machine(words) => {
                        ui.label(egui::RichText::new(words).size(HERO_PT).color(t.fg));
                    }
                    HeroSpan::Story(word) => {
                        ui.label(
                            egui::RichText::new(word)
                                .font(egui::FontId::new(HERO_PT, theme::story_bold_family()))
                                .color(t.fg),
                        );
                    }
                    HeroSpan::Cursor(on) => {
                        // Always laid out; the color steps, so the line
                        // never shifts as the cursor blinks.
                        let color = if *on {
                            t.accent
                        } else {
                            egui::Color32::TRANSPARENT
                        };
                        ui.label(egui::RichText::new("▊").size(HERO_PT).color(color));
                    }
                }
            }
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if ui.button("Add existing bundle…").clicked() {
                    self.pick_bundle();
                }
                if ui.button("Add files…").clicked() {
                    self.pick_files();
                }
            });
        });
        ui.label(egui::RichText::new(&hero.guidance).small().color(t.muted));
        // Idle-gated motion (the blink rationale's code home): the cursor
        // is the app's only ambient animation, and its repaints are
        // requested solely on this empty-queue path — with any job
        // present the hero stops rendering and this request stops with
        // it, so a busy window pays zero blink wakeups. egui has no OS
        // reduced-motion signal; gating motion to idle is the spec's
        // accepted desktop equivalent.
        ui.ctx()
            .request_repaint_after(blink_step_delay(ui.ctx().time()));
    }

    /// The working-queue strip: one compact line — small accent `❯`,
    /// both Add buttons, the drop hint — no cursor, no guidance (the
    /// queue itself is the message).
    fn prompt_compact(&mut self, ui: &mut egui::Ui) {
        let t = self.settings.theme.tokens();
        ui.horizontal(|ui| {
            ui.label(egui::RichText::new("❯").color(t.accent));
            if ui.button("Add files…").clicked() {
                self.pick_files();
            }
            if ui.button("Add existing bundle…").clicked() {
                self.pick_bundle();
            }
            ui.label(
                egui::RichText::new("…or drop files anywhere in this window.")
                    .small()
                    .color(t.muted),
            );
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
        let t = self.settings.theme.tokens();
        egui::Panel::right("side-panel")
            .default_size(300.0)
            .show(ui, |ui| {
                ui.heading("Voice");
                ui.label(
                    egui::RichText::new("New jobs use this voice; models download on first use.")
                        .small()
                        .color(t.muted),
                );
                let picked = views::voice::render(
                    ui,
                    t,
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

    /// The central queue: every job's row in one scroll — queue-only, by
    /// the shell's region split. The empty state's guidance lives up in
    /// the prompt hero, so an empty queue body renders nothing (the
    /// terminal idles at its prompt).
    fn queue_panel(&mut self, ui: &mut egui::Ui) {
        egui::CentralPanel::default().show(ui, |ui| {
            // Snapshot the rows first — the actions below need &mut self.
            let jobs: Vec<Job> = self.executor.queue().jobs().cloned().collect();
            egui::ScrollArea::vertical()
                .auto_shrink(false)
                .show(ui, |ui| {
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
                    ui.horizontal(|ui| {
                        ui.label(
                            egui::RichText::new(format!("Done → {}", out.display()))
                                .color(t.success),
                        );
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            if ui
                                .button("Read")
                                .on_hover_text("Open this bundle in the reader")
                                .clicked()
                            {
                                self.open_reader(ui.ctx(), out.clone());
                            }
                        });
                    });
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

    /// Leave the reader (the view's Back): the reader-exit save (task
    /// 007's cadence — the current position persists under the book's
    /// storage key), then the pure screen flip. The queue kept running
    /// underneath by construction.
    fn leave_reader(&mut self, view: Box<ReaderView>, ctx: &egui::Context) {
        view.save_position(ctx);
        self.screen = Screen::Converter;
    }

    /// The converter screen's regions below the shared chrome: prompt
    /// strip, status line, side panel, queue body.
    fn converter(&mut self, ui: &mut egui::Ui) {
        self.prompt_strip(ui);
        self.status_bar(ui);
        if self.panel_open {
            self.side_panel(ui);
        }
        self.queue_panel(ui);
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

    /// The frame: shared chrome (top bar + error banner), then whichever
    /// screen is showing. The side panel rides both screens (it
    /// configures future jobs, reader or not) and must precede each
    /// screen's central panel in layout order. The reader's Back is a
    /// pure screen flip — the queue lives in the executor and keeps
    /// running underneath.
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        self.top_bar(ui);
        self.error_banner(ui);
        match std::mem::replace(&mut self.screen, Screen::Converter) {
            Screen::Converter => self.converter(ui),
            Screen::Reader(mut view) => {
                if self.panel_open {
                    self.side_panel(ui);
                }
                let action = view.render(ui, self.settings.theme.tokens());
                match action {
                    Some(ReaderAction::Back) => self.leave_reader(view, ui.ctx()),
                    None => self.screen = Screen::Reader(view),
                }
            }
        }
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
    use crate::gui::theme::Theme;

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
    fn cursor_blinks_on_a_1_1s_step_end_cycle() {
        // On for the first half of each 1.1 s period, off for the
        // second, jumping at the boundary (step-end — no fade).
        assert!(cursor_on(0.0));
        assert!(cursor_on(0.54));
        assert!(!cursor_on(0.56));
        assert!(!cursor_on(1.09));
        // The period wraps: t = 1.1 is t = 0 again.
        assert!(cursor_on(BLINK_PERIOD_SECS));
        assert!(cursor_on(BLINK_PERIOD_SECS * 2.0));
        assert!(!cursor_on(BLINK_PERIOD_SECS + 0.56));
    }

    #[test]
    fn blink_delay_targets_the_next_toggle_exactly() {
        let close = |at: f64, want: f64| {
            let got = blink_step_delay(at).as_secs_f64();
            assert!(
                (got - want).abs() < 1e-9,
                "blink_step_delay({at}) = {got:.9}s, want {want}s"
            );
        };
        close(0.0, 0.55);
        close(0.5, 0.05);
        // Just past the off-toggle, the next wake is the period wrap.
        close(0.6, 0.5);
        close(1.05, 0.05);
        close(BLINK_PERIOD_SECS, 0.55);
        // A toggle is always in the future — never a zero (busy-loop) delay.
        for probe in [0.0, 0.25, 0.55, 0.8, 1.09] {
            assert!(
                blink_step_delay(probe).as_secs_f64() > 0.0,
                "zero delay at {probe}"
            );
        }
    }

    #[test]
    fn hero_places_the_story_word_inside_the_machine_prompt() {
        let on = hero(0.0);
        assert_eq!(
            on.spans,
            vec![
                HeroSpan::Prompt,
                HeroSpan::Machine("drop a".to_owned()),
                HeroSpan::Story("book".to_owned()),
                HeroSpan::Cursor(true),
            ]
        );
        // Mid-off-phase: same line, cursor stepped off — the layout
        // never changes, only the cursor's color does.
        assert_eq!(
            hero(0.6).spans,
            vec![
                HeroSpan::Prompt,
                HeroSpan::Machine("drop a".to_owned()),
                HeroSpan::Story("book".to_owned()),
                HeroSpan::Cursor(false),
            ]
        );
        // The guidance keeps the empty-state contract: what to drop and
        // the bundle re-voice hint.
        assert!(on.guidance.contains("document"));
        assert!(on.guidance.contains("audiobook"));
        assert!(on.guidance.contains("re-voice"));
    }

    #[test]
    fn prompt_strip_paints_hero_drag_and_compact_states_under_both_themes() {
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
                screen: Screen::Converter,
                open_error: None,
            };

            // Empty queue at t=0: the hero, cursor on.
            let _ = ctx.run_ui(egui::RawInput::default(), |ui| {
                app.prompt_strip(ui);
            });

            // Empty queue mid-blink (t=0.6, cursor off) with a file
            // dragging over the window: hero + accent drop-target frame.
            let drag = egui::RawInput {
                time: Some(0.6),
                hovered_files: vec![egui::HoveredFile::default()],
                ..Default::default()
            };
            let _ = ctx.run_ui(drag, |ui| {
                app.prompt_strip(ui);
            });

            // A queued job: the compact strip plus a drop summary under
            // it (rejection reason included).
            app.last_drop = Some(DropReport {
                enqueued: 1,
                duplicates: vec![],
                rejected: vec![(PathBuf::from("/books/art.zip"), "unsupported".to_owned())],
            });
            let _ = app
                .executor
                .add_files(&[PathBuf::from("/books/Fable of the Fox.epub")], "v");
            let _ = ctx.run_ui(egui::RawInput::default(), |ui| {
                app.prompt_strip(ui);
            });
        }
        // Painting every strip state under the real theme/fonts without
        // panicking is the assertion — egui aborts on layout/font misuse.
    }

    #[test]
    fn toggle_theme_flips_applies_and_persists_for_the_next_launch() {
        let ctx = egui::Context::default();
        theme::apply(&ctx, Theme::Dark);
        let mut app = TaleTrekApp {
            executor: Executor::new(),
            settings: Settings::load(&ctx),
            cache_dir: None,
            last_drop: None,
            panel_open: false,
            screen: Screen::Converter,
            open_error: None,
        };
        assert_eq!(app.settings.theme, Theme::Dark, "first run stays dark");

        app.toggle_theme(&ctx);
        assert_eq!(app.settings.theme, Theme::Sepia);
        // Applied in the same frame: the live style already carries
        // sepia's ground.
        assert_eq!(ctx.theme(), egui::Theme::Light);
        assert_eq!(
            ctx.style_of(egui::Theme::Light).visuals.panel_fill,
            Theme::Sepia.tokens().bg
        );
        // Persisted: a fresh load — the relaunch — sees sepia.
        assert_eq!(Settings::load(&ctx).theme, Theme::Sepia);

        // Flipping back restores dark, in style and in storage alike.
        app.toggle_theme(&ctx);
        assert_eq!(app.settings.theme, Theme::Dark);
        assert_eq!(ctx.theme(), egui::Theme::Dark);
        assert_eq!(
            ctx.style_of(egui::Theme::Dark).visuals.panel_fill,
            Theme::Dark.tokens().bg
        );
        assert_eq!(Settings::load(&ctx).theme, Theme::Dark);
    }

    #[test]
    fn top_bar_paints_under_both_themes() {
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
                screen: Screen::Converter,
                open_error: None,
            };
            // Both side-panel states: the ⚙ toggle rides the bar either way.
            for panel_open in [false, true] {
                app.panel_open = panel_open;
                let _ = ctx.run_ui(egui::RawInput::default(), |ui| {
                    app.top_bar(ui);
                });
            }
        }
        // Painting the bar (brand mark + theme toggle + panel toggle,
        // elevated frame, machine-bold face) under the real theme/fonts
        // without panicking is the assertion — egui aborts on
        // layout/font misuse.
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
                screen: Screen::Converter,
                open_error: None,
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

    // ---- reader screen switch (task 004) --------------------------------

    use taletrek_synth::bundle::manifest::{AudioMeta, BookMeta, Generator, ManifestKind};
    use taletrek_synth::{
        write_book_bundle, AudioCodec, BookBundle, ChapterText, Manifest, NORM_VERSION,
        SCHEMA_VERSION,
    };

    fn app_on_converter(ctx: &egui::Context) -> TaleTrekApp {
        let mut settings = Settings::load(ctx);
        settings.theme = theme::Theme::Dark;
        TaleTrekApp {
            executor: Executor::new(),
            settings,
            cache_dir: None,
            last_drop: None,
            panel_open: false,
            screen: Screen::Converter,
            open_error: None,
        }
    }

    /// A healthy two-chapter bundle on disk; returns (kept-alive dir, path).
    fn readable_bundle() -> (tempfile::TempDir, PathBuf) {
        bundle_on_disk(&gui_bundle(false, "en_US-amy-medium"))
    }

    /// The fixture bundle as data: book id `bk_gui`, two chapters,
    /// audio presence and voice parameterized (the re-voice shape is
    /// the same id under a different voice).
    fn gui_bundle(audio: bool, voice: &str) -> BookBundle {
        BookBundle {
            manifest: Manifest {
                schema_version: SCHEMA_VERSION,
                kind: ManifestKind::Book,
                book: BookMeta {
                    id: "bk_gui".into(),
                    title: "GUI Fixture".into(),
                    author: None,
                    source_format: "txt".into(),
                    chapter_count: 2,
                    voice_id: voice.into(),
                    created_at: 0,
                    updated_at: 0,
                    progress_fraction: None,
                },
                audio: AudioMeta {
                    present: audio,
                    codec: AudioCodec::Opus,
                    norm_version: NORM_VERSION.parse().unwrap(),
                    segment_count: 0,
                },
                generator: Generator {
                    app: "taletrek-test".into(),
                    version: "0.0.0".into(),
                },
            },
            chapters: vec![
                ChapterText::new("bk_gui", 0, "One", vec!["First.".into()]),
                ChapterText::new("bk_gui", 1, "Two", vec!["Second.".into()]),
            ],
            audio: std::collections::HashMap::new(),
        }
    }

    /// Write `bundle` to a fresh temp file; returns (kept-alive dir, path).
    fn bundle_on_disk(bundle: &BookBundle) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fixture.taletrek");
        let mut buf = std::io::Cursor::new(Vec::new());
        write_book_bundle(bundle, &mut buf).unwrap();
        std::fs::write(&path, buf.into_inner()).unwrap();
        (dir, path)
    }

    #[test]
    fn open_reader_switches_to_the_reader_screen_and_clears_stale_errors() {
        let (_dir, path) = readable_bundle();
        let ctx = egui::Context::default();
        let mut app = app_on_converter(&ctx);
        app.open_error = Some("stale failure".to_owned());

        app.open_reader(&ctx, path.clone());

        assert!(
            matches!(app.screen, Screen::Reader(_)),
            "a healthy bundle switches screens"
        );
        assert_eq!(app.open_error, None, "success clears the banner");
    }

    #[test]
    fn open_reader_failure_stays_on_the_current_screen_with_a_sentence() {
        let ctx = egui::Context::default();
        let mut app = app_on_converter(&ctx);

        app.open_reader(
            &ctx,
            PathBuf::from("/nonexistent-taletrek-test/none.taletrek"),
        );

        assert!(matches!(app.screen, Screen::Converter));
        let message = app.open_error.as_deref().expect("failure surfaces");
        assert!(
            message.contains("Couldn't open"),
            "names the attempt: {message}"
        );
        assert!(
            message.contains("missing"),
            "carries the sentence: {message}"
        );
    }

    #[test]
    fn error_banner_and_reader_screen_paint_under_both_themes() {
        let (_dir, path) = readable_bundle();
        for theme in [theme::Theme::Dark, theme::Theme::Sepia] {
            let ctx = egui::Context::default();
            theme::apply(&ctx, theme);
            let mut app = app_on_converter(&ctx);
            app.settings.theme = theme;

            // The failure banner: shared chrome over either screen.
            app.open_error =
                Some("Couldn't open /tmp/none.taletrek — the file is missing.".to_owned());
            let _ = ctx.run_ui(egui::RawInput::default(), |ui| {
                app.top_bar(ui);
                app.error_banner(ui);
            });

            // The full reader path — the same calls `ui` dispatches: open,
            // then shared chrome + panels around the view.
            app.open_reader(&ctx, path.clone());
            app.panel_open = true;
            if let Screen::Reader(mut view) = std::mem::replace(&mut app.screen, Screen::Converter)
            {
                let _ = ctx.run_ui(egui::RawInput::default(), |ui| {
                    let action = view.render(ui, theme.tokens());
                    assert_eq!(action, None, "no interaction means no action");
                });
                app.screen = Screen::Reader(view);
            }
        }
        // Painting the banner and the reader screen (side panel open)
        // under the real theme/fonts without panicking is the assertion.
    }

    #[test]
    fn back_from_the_reader_is_a_pure_screen_flip_queue_intact() {
        let (_dir, path) = readable_bundle();
        let ctx = egui::Context::default();
        let mut app = app_on_converter(&ctx);
        let _ = app
            .executor
            .add_files(&[PathBuf::from("/books/Fable of the Fox.epub")], "v");
        let queued = app.executor.queue().jobs().count();
        assert_eq!(queued, 1);

        app.open_reader(&ctx, path);
        assert!(matches!(app.screen, Screen::Reader(_)));

        // The Back the view reports flips the screen and nothing else.
        let screen = std::mem::replace(&mut app.screen, Screen::Converter);
        drop(screen);
        assert!(matches!(app.screen, Screen::Converter));
        assert_eq!(
            app.executor.queue().jobs().count(),
            queued,
            "the queue is the executor's — reading never touches it"
        );
    }

    #[test]
    fn reader_session_renders_chapters_from_the_kernel_index() {
        // The shell hands the view a session built from the kernel core;
        // the view never re-derives structure of its own.
        let (_dir, path) = readable_bundle();
        let session = reader::session::open(&path).expect("fixture opens");
        assert_eq!(session.book.chapters.len(), 2);
        assert!(session
            .book
            .chapters
            .iter()
            .all(|ch| !ch.paragraphs.is_empty()));
        assert_eq!(session.book.title, "GUI Fixture");
    }

    // ---- position persistence (task 007) ------------------------------

    use taletrek_reader::Position;

    #[test]
    fn open_reader_restores_the_saved_position_from_the_store() {
        let (_dir, path) = bundle_on_disk(&gui_bundle(true, "en_US-amy-medium"));
        let ctx = egui::Context::default();
        reader::position_store::save(&ctx, "bk_gui", Position::new(1, 0, 4.5));
        let mut app = app_on_converter(&ctx);

        app.open_reader(&ctx, path);

        let Screen::Reader(view) = &app.screen else {
            panic!("a healthy narrated bundle opens");
        };
        assert_eq!(view.shown_chapter(), 1, "the pane opens on the saved chapter");
        assert_eq!(
            view.position(),
            Some(Position::new(1, 0, 4.5)),
            "the machine seeds paused at the saved paragraph"
        );
    }

    #[test]
    fn a_revoiced_copy_keeps_its_position_via_the_book_id() {
        // The re-voice shape: same book id, different voice, a different
        // file — progress keys by the book, not the file or the voice.
        let (_dir2, revoiced) = bundle_on_disk(&gui_bundle(true, "en_GB-cori-medium"));
        let ctx = egui::Context::default();
        reader::position_store::save(&ctx, "bk_gui", Position::new(1, 0, 4.5));
        let mut app = app_on_converter(&ctx);

        app.open_reader(&ctx, revoiced);

        let Screen::Reader(view) = &app.screen else {
            panic!("the re-voiced copy opens");
        };
        assert_eq!(view.shown_chapter(), 1);
        assert_eq!(
            view.position(),
            Some(Position::new(1, 0, 4.5)),
            "same book id → the saved place survives the re-voice"
        );
    }

    #[test]
    fn leaving_the_reader_persists_the_current_position() {
        let (_dir, path) = bundle_on_disk(&gui_bundle(true, "en_US-amy-medium"));
        let ctx = egui::Context::default();
        reader::position_store::save(&ctx, "bk_gui", Position::new(1, 0, 4.5));
        let mut app = app_on_converter(&ctx);
        app.open_reader(&ctx, path);

        // The user jumps back to chapter One (a paused seek — records
        // the move without commanding audio), then leaves the reader:
        // the exit save writes where the session actually stood.
        if let Screen::Reader(mut view) = std::mem::replace(&mut app.screen, Screen::Converter) {
            view.open_chapter(0);
            app.leave_reader(view, &ctx);
        }
        assert!(matches!(app.screen, Screen::Converter));
        assert_eq!(
            reader::position_store::load(&ctx, "bk_gui"),
            Some(Position::new(0, 0, 0.0)),
            "Back persists the position it leaves at"
        );
    }
}
