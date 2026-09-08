//! The reader screen's egui surface: title/meta header, chapter
//! outline, per-chapter text pane, and the transport bar.
//!
//! Presentational (the views' pattern): it renders the [`ReaderSession`]
//! it owns and returns user intents ([`ReaderAction::Back`]) — no queue
//! or executor knowledge. The whole book is never one scroll: the
//! outline switches chapters and the pane renders exactly one
//! (web-reader precedent; the big-book mitigation). Task 005 wired
//! playback: the view owns a [`Playback`] controller (spawned only for
//! narrated bundles — a text-only session spawns no audio thread at
//! all), pumps it every frame, forwards transport-button intents as
//! [`PlayerEvent`]s, and renders the machine it gets back. Task 006
//! layered the sync UX on top: the active paragraph highlights
//! (accent frame), the pane follows it while it stays in view and
//! stops when the user scrolls elsewhere
//! ([`scroll::follow_decision`] — the pure rule), paragraph clicks and
//! outline entries seek, and the scrub slider commits one
//! restart-at-offset [`PlayerEvent::SeekWithinParagraph`] per gesture.
//! Task 007 made the position durable: the view opens on a restored
//! [`Position`] (paused at the saved paragraph, its chapter shown) and
//! saves on cadence — paragraph advance and leaving the reader —
//! through [`super::position_store`], never per-frame.
//!
//! Type note: book *content* renders in the story face (XCharter) — the
//! reading typeface — while chrome (outline, transport, meta) stays in
//! the machine face. The `desktop-ux-refresh` type rule pinned the
//! machine face for converter chrome before a reader existed; a reading
//! app setting book text in monospace would invert the identity.

use std::sync::Arc;
use std::time::Duration;

use eframe::egui;

use taletrek_reader::{BookIndex, ParagraphPos, PlayerEvent, PlayerState, Position};

use super::audio::{AudioEngine, CpalDevice};
use super::playback::Playback;
use super::position_store;
use super::scroll;
use super::session::ReaderSession;
use crate::gui::theme::{self, Tokens};

/// The reader's paragraph text size in pt — one step above the 14 pt
/// chrome base, book-text scale.
const BODY_PT: f32 = 16.0;

/// The reader header's book-title size in pt (the heading scale, serif).
const TITLE_PT: f32 = 18.0;

/// The outline panel's width in points.
const OUTLINE_WIDTH: f32 = 200.0;

/// How long the reader may sleep before another frame while audio
/// plays — the tick cadence the transport's position label and the
/// highlight's follow ride.
const PLAYING_REPAINT: Duration = Duration::from_millis(150);

/// How strongly the accent tints the active paragraph's fill
/// (web `bg-accent-soft`): a breath, readable through.
const ACTIVE_TINT: f32 = 0.14;

/// What the reader screen asks the shell to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReaderAction {
    /// Return to the converter screen (queue state is the executor's —
    /// untouched by construction).
    Back,
}

/// Headless-test probes: what the last paint laid out — paragraph
/// rects, the highlighted rect, the pane's visible rect, the scrub
/// slider's rect — so pointer-event tests aim at real geometry.
#[cfg(test)]
#[derive(Default)]
pub(crate) struct PaintProbe {
    /// The shown chapter's paragraph rects, in reading order.
    pub(crate) rects: Vec<egui::Rect>,
    /// The rect painted as the active paragraph, if any.
    pub(crate) active_rect: Option<egui::Rect>,
    /// The text pane's visible rect (the scroll viewport).
    pub(crate) view_rect: Option<egui::Rect>,
    /// The scrub slider's rect, if it rendered.
    pub(crate) scrub_rect: Option<egui::Rect>,
}

/// The reader screen: one open session plus the view-local state (the
/// selected chapter, the playback controller for narrated bundles, the
/// sync-UX follow bookkeeping).
pub(crate) struct ReaderView {
    /// The opened bundle (open-flow output).
    session: ReaderSession,
    /// The chapter the text pane shows (index into `session.book.chapters`).
    chapter: usize,
    /// The playback controller — `None` on text-only bundles (no engine
    /// thread spawns; the transport renders disabled with its hint).
    playback: Option<Playback>,
    /// Whether the pane follows playback (see [`scroll`] for the rule).
    following: bool,
    /// The paragraph the last pane paint saw active — the change signal
    /// the follow decision feeds on.
    last_active: Option<ParagraphPos>,
    /// A user position jump happened this frame (outline entry,
    /// transport skip) — the re-anchor flag the next pane paint
    /// consumes. Paragraph clicks set it directly in the pane.
    anchor: bool,
    /// The scrub slider's local value — tracks the machine's offset
    /// except mid-gesture, when it holds the drag.
    scrub: f64,
    /// Headless-test geometry probes.
    #[cfg(test)]
    probe: PaintProbe,
}

impl ReaderView {
    /// A fresh view over an opened session, starting at the first
    /// chapter. Narrated sessions spawn the audio engine here; the
    /// device itself stays untouched until the first play. Task 007:
    /// a restored [`Position`] (the store's answer for this book)
    /// seeds the machine paused at it and opens its chapter — the
    /// first paint's follow decision scrolls it into view.
    pub(crate) fn new(session: ReaderSession, restore: Option<Position>) -> Self {
        let mut playback = session.book.audio_present.then(|| {
            Playback::new(Box::new(AudioEngine::new(
                session.path.clone(),
                Arc::new(CpalDevice),
            )))
        });
        let mut chapter = 0;
        if let (Some(pb), Some(pos)) = (&mut playback, restore) {
            if pb.seed(pos, &session.book) {
                if let Ok(c) = usize::try_from(pos.chapter) {
                    chapter = c;
                }
            }
        }
        if !session.book.chapters.is_empty() {
            chapter = chapter.min(session.book.chapters.len() - 1);
        } else {
            chapter = 0;
        }
        Self {
            session,
            chapter,
            playback,
            following: true,
            last_active: None,
            anchor: false,
            scrub: 0.0,
            #[cfg(test)]
            probe: PaintProbe::default(),
        }
    }

    /// The chapter the text pane shows (the restore-wiring probe for
    /// tests outside this module).
    #[cfg(test)]
    pub(crate) fn shown_chapter(&self) -> usize {
        self.chapter
    }

    /// The session's current position as durable data (`None` at idle
    /// or on a text-only book) — what [`Self::save_position`] writes.
    pub(crate) fn position(&self) -> Option<Position> {
        self.playback
            .as_ref()
            .and_then(|pb| Position::capture(pb.state()))
    }

    /// The reader-exit save (task 007's cadence): persist the current
    /// position under the book's storage key. Leaving the reader and
    /// closing the app both flush through here or through the
    /// advance-time save in the pane — never per-frame.
    pub(crate) fn save_position(&self, ctx: &egui::Context) {
        if let Some(pos) = self.position() {
            position_store::save(ctx, &self.session.book.book_id, pos);
        }
    }

    /// Switch the text pane to `chapter`, clamped to the book (an
    /// out-of-range outline target can never panic the pane).
    pub(crate) fn select_chapter(&mut self, chapter: usize) {
        if self.session.book.chapters.is_empty() {
            self.chapter = 0;
        } else {
            self.chapter = chapter.min(self.session.book.chapters.len() - 1);
        }
    }

    /// An outline entry: switch the pane to `chapter` and, when it has
    /// one, seek playback to its first paragraph (the seek re-anchors
    /// following — see [`scroll::follow_decision`]). An empty or
    /// out-of-range chapter only switches the view.
    pub(crate) fn open_chapter(&mut self, chapter: usize) {
        let target = scroll::chapter_seek_target(&self.session.book, chapter);
        self.select_chapter(chapter);
        if let Some(target) = target {
            if let Some(playback) = &mut self.playback {
                playback.send(PlayerEvent::SeekToParagraph(target), &self.session.book);
                self.anchor = true;
            }
        }
    }

    /// Paint the reader screen inside `ui`: header (top), transport
    /// (bottom), outline (left), text pane (center). Pumps the engine
    /// first so the bar renders this frame's truth. Returns the intent
    /// if the user asked to leave.
    pub(crate) fn render(&mut self, ui: &mut egui::Ui, t: Tokens) -> Option<ReaderAction> {
        let mut action = None;

        if let Some(playback) = &mut self.playback {
            playback.pump(&self.session.book);
        }

        // Chrome sits on surface; the reading pane stays on the panel
        // ground — the paper the story renders on.
        egui::Panel::top("reader-header")
            .resizable(false)
            .frame(
                egui::Frame::default()
                    .fill(t.surface)
                    .inner_margin(egui::Margin::symmetric(8, 4)),
            )
            .show(ui, |ui| {
                ui.horizontal(|ui| {
                    if ui
                        .button("Back to queue")
                        .on_hover_text("Return to the converter (the queue keeps running)")
                        .clicked()
                    {
                        action = Some(ReaderAction::Back);
                    }
                    ui.label(
                        egui::RichText::new(self.session.book.title.clone())
                            .font(egui::FontId::new(TITLE_PT, theme::story_bold_family()))
                            .color(t.fg),
                    );
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        ui.label(
                            egui::RichText::new(&self.session.meta)
                                .small()
                                .color(t.muted),
                        );
                    });
                });
            });

        self.transport(ui, t);
        self.outline(ui, t);
        self.text_pane(ui, t);

        // While audio plays, keep frames coming so ticks land (the
        // position label and the highlight's follow ride them).
        if self
            .playback
            .as_ref()
            .is_some_and(|pb| matches!(pb.state(), PlayerState::Playing { .. }))
        {
            ui.ctx().request_repaint_after(PLAYING_REPAINT);
        }
        action
    }

    /// The chapter outline: one token-styled row per chapter, the current
    /// chapter picked out in accent. Clicking opens the chapter — the
    /// pane switches and playback seeks its first paragraph.
    fn outline(&mut self, ui: &mut egui::Ui, t: Tokens) {
        egui::Panel::left("reader-outline")
            .resizable(false)
            .default_size(OUTLINE_WIDTH)
            .frame(
                egui::Frame::default()
                    .fill(t.surface)
                    .inner_margin(egui::Margin::same(8)),
            )
            .show(ui, |ui| {
                ui.label(egui::RichText::new("Chapters").small().color(t.muted));
                ui.add_space(4.0);
                // Snapshot before the loop: the click handler needs &mut
                // self, so the borrow over the book's chapters must end.
                let entries: Vec<(usize, String)> = self
                    .session
                    .book
                    .chapters
                    .iter()
                    .enumerate()
                    .map(|(idx, ch)| {
                        (
                            idx,
                            if ch.title.trim().is_empty() {
                                "(untitled)".to_owned()
                            } else {
                                ch.title.clone()
                            },
                        )
                    })
                    .collect();
                egui::ScrollArea::vertical()
                    .auto_shrink(false)
                    .show(ui, |ui| {
                        for (idx, title) in &entries {
                            let selected = *idx == self.chapter;
                            let text = egui::RichText::new(title.as_str())
                                .small()
                                .color(if selected { t.accent } else { t.fg });
                            let button = egui::Button::new(text)
                                .fill(if selected {
                                    t.elevated
                                } else {
                                    egui::Color32::TRANSPARENT
                                })
                                .stroke(egui::Stroke::new(
                                    1.0,
                                    if selected { t.accent } else { t.line },
                                ));
                            if ui.add(button).clicked() {
                                self.open_chapter(*idx);
                            }
                        }
                    });
            });
    }

    /// The text pane: exactly one chapter (the outline switches), laid
    /// out in the story face — the whole book is never one scroll. The
    /// scroll is keyed by chapter id, so each chapter keeps its own
    /// position across switches. Task 006: the active paragraph paints
    /// highlighted, paragraphs seek on click, and the pane follows
    /// playback — the pure decision in [`scroll::follow_decision`],
    /// executed here against real geometry.
    fn text_pane(&mut self, ui: &mut egui::Ui, t: Tokens) {
        let ReaderView {
            session,
            chapter,
            playback,
            following,
            last_active,
            anchor,
            #[cfg(test)]
            probe,
            ..
        } = self;

        let active = playback
            .as_ref()
            .and_then(|pb| active_paragraph(pb.state()));

        // While following, the pane tracks playback across chapter
        // bounds — the highlight must land somewhere visible. Free
        // mode (the user reading elsewhere) never switches chapters.
        if *following {
            if let Some(pos) = active {
                if let Ok(c) = usize::try_from(pos.chapter) {
                    if c < session.book.chapters.len() {
                        *chapter = c;
                    }
                }
            }
        }

        egui::CentralPanel::default().show(ui, |ui| {
            let Some(ch) = session.book.chapters.get(*chapter) else {
                ui.label(
                    egui::RichText::new("This bundle has no chapters.")
                        .small()
                        .color(t.muted),
                );
                return;
            };
            let shown = *chapter;
            let shown_ch = u32::try_from(shown).unwrap_or(u32::MAX);
            let clickable = playback.is_some();

            egui::ScrollArea::vertical()
                .auto_shrink(false)
                .id_salt(ch.id.as_str())
                .show(ui, |ui| {
                    ui.add_space(10.0);
                    ui.label(
                        egui::RichText::new(&ch.title)
                            .font(egui::FontId::new(TITLE_PT, theme::story_bold_family()))
                            .color(t.fg),
                    );
                    ui.add_space(10.0);
                    if ch.paragraphs.is_empty() {
                        ui.label(
                            egui::RichText::new("This chapter has no text.")
                                .small()
                                .color(t.muted),
                        );
                    }

                    // One frame per paragraph — identical geometry
                    // whether highlighted or not, so the highlight
                    // never reflows the text as it moves.
                    let mut rects: Vec<egui::Rect> = Vec::with_capacity(ch.paragraphs.len());
                    let mut pane_seek = false;
                    for (i, paragraph) in ch.paragraphs.iter().enumerate() {
                        let is_active =
                            active.is_some_and(|a| a.chapter == shown_ch && a.index == i as u32);
                        let pane = egui::Frame::default()
                            .fill(if is_active {
                                accent_soft(t)
                            } else {
                                egui::Color32::TRANSPARENT
                            })
                            .stroke(if is_active {
                                egui::Stroke::new(1.0, t.accent)
                            } else {
                                egui::Stroke::NONE
                            })
                            .inner_margin(egui::Margin::symmetric(6, 3))
                            .show(ui, |ui| {
                                ui.label(
                                    egui::RichText::new(&paragraph.text)
                                        .font(egui::FontId::new(BODY_PT, theme::story_family()))
                                        .color(t.fg),
                                );
                            });
                        let rect = pane.response.rect;
                        if clickable {
                            let resp = ui.interact(
                                rect,
                                egui::Id::new(&paragraph.id),
                                egui::Sense::click(),
                            );
                            if resp.hovered() {
                                ui.output_mut(|o| o.cursor_icon = egui::CursorIcon::PointingHand);
                            }
                            if resp.clicked() {
                                if let Some(pb) = playback.as_mut() {
                                    pb.send(
                                        PlayerEvent::SeekToParagraph(ParagraphPos::new(
                                            shown_ch, i as u32,
                                        )),
                                        &session.book,
                                    );
                                    pane_seek = true;
                                }
                            }
                        }
                        rects.push(rect);
                        ui.add_space(10.0);
                    }

                    // --- the follow decision, on this frame's truth ----
                    // Effective position: pane clicks above may have
                    // moved it since `active` was read.
                    let effective = playback
                        .as_ref()
                        .and_then(|pb| active_paragraph(pb.state()));
                    let active_rect = effective
                        .filter(|p| p.chapter == shown_ch)
                        .and_then(|p| rects.get(p.index as usize))
                        .copied();
                    let view = ui.clip_rect();
                    let decision = scroll::follow_decision(scroll::FollowInput {
                        paragraph_changed: effective != *last_active,
                        seek: std::mem::take(&mut *anchor) || pane_seek,
                        active_in_view: active_rect.map(|r| r.intersects(view)),
                        following: *following,
                    });
                    *following = decision.following;
                    if decision.scroll_to_active {
                        if let Some(rect) = active_rect {
                            // Instant, not animated: an in-flight
                            // animation would look identical to "the
                            // user scrolled away" on the next frame
                            // (unchanged paragraph, out of view) and
                            // pause following mid-flight.
                            ui.scroll_to_rect_animation(
                                rect,
                                Some(egui::Align::Center),
                                egui::style::ScrollAnimation::none(),
                            );
                        }
                    }
                    // Task 007's advance-time save: when the active
                    // paragraph moved, the store moves with it. The
                    // gate is the paragraph, not the frame — ticks and
                    // repaints (offset churn, highlight paints) never
                    // write, so there is no save storm.
                    if effective.is_some() && effective != *last_active {
                        if let Some(pos) = playback
                            .as_ref()
                            .and_then(|pb| Position::capture(pb.state()))
                        {
                            position_store::save(ui.ctx(), &session.book.book_id, pos);
                        }
                    }
                    *last_active = effective;

                    #[cfg(test)]
                    {
                        probe.rects = rects;
                        probe.active_rect = active_rect;
                        probe.view_rect = Some(view);
                    }
                });
        });
    }

    /// The transport bar: prev/next chapter (`|<`, `>|`), prev/next
    /// paragraph (`<`, `>`), the play/pause toggle, and the scrub
    /// slider — all forwarded as [`PlayerEvent`]s through the
    /// controller; the machine's position and failure log render
    /// beside them. Text-only bundles keep task 004's disabled
    /// controls + hint (they must read *fully* here, and no engine
    /// ever spawned).
    fn transport(&mut self, ui: &mut egui::Ui, t: Tokens) {
        let ReaderView {
            session,
            playback,
            anchor,
            scrub,
            #[cfg(test)]
            probe,
            ..
        } = self;
        egui::Panel::bottom("reader-transport")
            .resizable(false)
            .frame(
                egui::Frame::default()
                    .fill(t.surface)
                    .inner_margin(egui::Margin::symmetric(8, 4)),
            )
            .show(ui, |ui| {
                ui.horizontal(|ui| {
                    match playback {
                        None => {
                            for label in ["|<", "<", "Play", ">", ">|"] {
                                ui.add_enabled(false, egui::Button::new(label));
                            }
                            if let Some(hint) = transport_hint(false) {
                                ui.label(egui::RichText::new(hint).small().color(t.muted));
                            }
                        }
                        Some(playback) => {
                            // Snapshot the machine first: the click
                            // handlers below need `&mut` playback.
                            let state = playback.state().clone();
                            let duration = playback.segment_duration();
                            let playing = matches!(state, PlayerState::Playing { .. });
                            let toggle = if playing {
                                ("Pause", PlayerEvent::Pause)
                            } else {
                                ("Play", PlayerEvent::Play)
                            };
                            let buttons: [(&str, PlayerEvent); 5] = [
                                ("|<", PlayerEvent::PrevChapter),
                                ("<", PlayerEvent::PrevParagraph),
                                toggle,
                                (">", PlayerEvent::NextParagraph),
                                (">|", PlayerEvent::NextChapter),
                            ];
                            for (label, ev) in buttons {
                                if ui.button(label).clicked() {
                                    if scroll::re_anchors(&ev) {
                                        *anchor = true;
                                    }
                                    playback.send(ev, &session.book);
                                }
                            }

                            // The scrub: one seek per gesture. The
                            // slider's local value tracks the
                            // machine's offset except mid-drag; the
                            // commit (drag end or click) fires the
                            // single restart-at-offset seek.
                            let offset = match &state {
                                PlayerState::Playing { offset, .. }
                                | PlayerState::Paused { offset, .. } => Some(*offset),
                                PlayerState::Idle { .. } => None,
                            };
                            if let (Some(offset), Some(d)) = (offset, duration) {
                                if d > 0.0 {
                                    let resp =
                                        ui.add(egui::Slider::new(scrub, 0.0..=d).show_value(false));
                                    #[cfg(test)]
                                    {
                                        probe.scrub_rect = Some(resp.rect);
                                    }
                                    if !resp.dragged() && !resp.drag_stopped() {
                                        *scrub = offset.clamp(0.0, d);
                                    }
                                    if resp.drag_stopped() || resp.clicked() {
                                        playback.send(
                                            PlayerEvent::SeekWithinParagraph(*scrub),
                                            &session.book,
                                        );
                                    }
                                }
                            }

                            if let Some(position) = position_label(&state, &session.book, duration)
                            {
                                ui.label(egui::RichText::new(position).small().color(t.muted));
                            }
                            // The skip path's non-modal surfacing: one
                            // line, danger-tinted, no dialogs.
                            let failures = state.failures();
                            if failures.skipped > 0 {
                                let last =
                                    failures.last_error.as_deref().unwrap_or("unknown error");
                                ui.label(
                                    egui::RichText::new(format!(
                                        "Skipped {} — {last}",
                                        failures.skipped
                                    ))
                                    .small()
                                    .color(t.danger),
                                );
                            }
                        }
                    }
                });
            });
    }
}

/// The active paragraph of a machine, if it has one.
fn active_paragraph(state: &PlayerState) -> Option<ParagraphPos> {
    match state {
        PlayerState::Playing { para, .. } | PlayerState::Paused { para, .. } => Some(*para),
        PlayerState::Idle { .. } => None,
    }
}

/// The active paragraph's fill: the accent breathed into the pane's
/// ground (web `bg-accent-soft`) — quiet enough to read through.
fn accent_soft(t: Tokens) -> egui::Color32 {
    let mix = |ground: u8, phosphor: u8| -> u8 {
        (f32::from(ground) * (1.0 - ACTIVE_TINT) + f32::from(phosphor) * ACTIVE_TINT).round() as u8
    };
    egui::Color32::from_rgb(
        mix(t.bg.r(), t.accent.r()),
        mix(t.bg.g(), t.accent.g()),
        mix(t.bg.b(), t.accent.b()),
    )
}

/// The transport placeholder's hint: `None` when the bundle carries
/// audio, and the explanatory sentence when it doesn't — a text-only
/// book must explain its own silence.
pub(crate) fn transport_hint(audio_present: bool) -> Option<&'static str> {
    if audio_present {
        None
    } else {
        Some(
            "This bundle has no audio yet — add narration with Add existing bundle… \
             (re-voice), then reopen it.",
        )
    }
}

/// `m:ss` for a seconds value.
fn mmss(secs: f64) -> String {
    let total = secs.max(0.0).floor() as u64;
    format!("{}:{:02}", total / 60, total % 60)
}

/// The transport's position readout: book-wide paragraph ordinal and
/// `m:ss` into the current paragraph while playing or paused, over the
/// segment's decoded length once the load ack carried it; nothing
/// before the first play.
pub(crate) fn position_label(
    state: &PlayerState,
    book: &BookIndex,
    duration: Option<f64>,
) -> Option<String> {
    let (para, offset) = match state {
        PlayerState::Playing { para, offset, .. } | PlayerState::Paused { para, offset, .. } => {
            (*para, *offset)
        }
        PlayerState::Idle { .. } => return None,
    };
    let mut line = String::new();
    if let Some((n, total)) = scroll::paragraph_ordinal(book, para) {
        line.push_str(&format!("¶ {n}/{total} · "));
    }
    line.push_str(&mmss(offset));
    if let Some(d) = duration {
        line.push_str(" / ");
        line.push_str(&mmss(d));
    }
    Some(line)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::gui::reader::playback::ScriptedTransport;
    use crate::gui::reader::session::{self, ReaderSession};
    use crate::gui::theme::Theme;
    use taletrek_reader::BookIndex;
    use taletrek_synth::bundle::manifest::{AudioMeta, BookMeta, Generator, ManifestKind};
    use taletrek_synth::{AudioCodec, ChapterText, Manifest, NORM_VERSION, SCHEMA_VERSION};

    fn manifest(audio: bool) -> Manifest {
        Manifest {
            schema_version: SCHEMA_VERSION,
            kind: ManifestKind::Book,
            book: BookMeta {
                id: "bk_test".into(),
                title: "A Small Adventure".into(),
                author: Some("Ursula Vernon".into()),
                source_format: "epub".into(),
                chapter_count: 3,
                voice_id: "en_US-amy-medium".into(),
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
        }
    }

    fn chapters() -> Vec<ChapterText> {
        vec![
            ChapterText::new(
                "bk_test",
                0,
                "The Beginning",
                vec![
                    "The fox stepped onto the bridge and considered the toll.".into(),
                    "Below, the river kept its own counsel, as rivers do.".into(),
                ],
            ),
            ChapterText::new("bk_test", 1, "Interlude", vec![]),
            ChapterText::new(
                "bk_test",
                2,
                "The End",
                vec!["The far side was not so different, but it was elsewhere.".into()],
            ),
        ]
    }

    fn fixture(audio: bool) -> ReaderSession {
        let manifest = manifest(audio);
        let chapters = chapters();
        let book = BookIndex::new(&manifest, &chapters);
        let meta = session::meta_line(&manifest, &book);
        ReaderSession {
            path: "/books/adventure.taletrek".into(),
            book,
            meta,
        }
    }

    /// A many-paragraph chapter-0 book: content far taller than any
    /// test viewport, so scroll behavior is exercisable headlessly.
    fn tall_fixture() -> ReaderSession {
        let manifest = manifest(true);
        let paragraphs: Vec<String> = (0..40)
            .map(|i| {
                format!(
                    "Paragraph {i} runs long enough to wrap across a \
                     couple of pane lines, so the chapter towers over \
                     the viewport and scrolling means something."
                )
            })
            .collect();
        let chapters = vec![ChapterText::new("bk_test", 0, "Tall", paragraphs)];
        let book = BookIndex::new(&manifest, &chapters);
        ReaderSession {
            path: "/books/tall.taletrek".into(),
            book,
            meta: "40 paragraphs · v · narrated".into(),
        }
    }

    /// A scripted live view over `session`, playing paragraph `index`
    /// of chapter 0, with the load acked (duration armed).
    fn playing_view(
        session: ReaderSession,
        index: u32,
        duration: f64,
    ) -> (ReaderView, Arc<ScriptedTransport>) {
        let mut view = ReaderView::new(session, None);
        let scripted = Arc::new(ScriptedTransport::new());
        let mut live = crate::gui::reader::playback::controller(scripted.clone());
        live.send(PlayerEvent::Play, &view.session.book);
        if index > 0 {
            for _ in 0..index {
                live.send(PlayerEvent::NextParagraph, &view.session.book);
            }
        }
        let key = view.session.book.chapters[0].paragraphs[index as usize]
            .segment_key
            .clone();
        scripted.push(crate::gui::reader::audio::AudioEvent::Loaded { key, duration });
        live.pump(&view.session.book);
        view.playback = Some(live);
        (view, scripted)
    }

    /// One paint pass with the given events over a fixed 1024×600
    /// screen (the headless default is a huge virtual viewport in
    /// which nothing can ever scroll); returns the view after.
    fn paint(mut view: ReaderView, ctx: &egui::Context, events: Vec<egui::Event>) -> ReaderView {
        let input = egui::RawInput {
            events,
            screen_rect: Some(egui::Rect::from_min_size(
                egui::Pos2::ZERO,
                egui::vec2(1024.0, 600.0),
            )),
            ..Default::default()
        };
        let t = Theme::Dark.tokens();
        let _ = ctx.run_ui(input, |ui| {
            view.render(ui, t);
        });
        view
    }

    fn pointer_down(pos: egui::Pos2) -> egui::Event {
        egui::Event::PointerButton {
            pos,
            button: egui::PointerButton::Primary,
            pressed: true,
            modifiers: egui::Modifiers::default(),
        }
    }

    fn pointer_up(pos: egui::Pos2) -> egui::Event {
        egui::Event::PointerButton {
            pos,
            button: egui::PointerButton::Primary,
            pressed: false,
            modifiers: egui::Modifiers::default(),
        }
    }

    #[test]
    fn transport_hint_only_appears_for_text_only_bundles() {
        assert_eq!(transport_hint(true), None);
        let hint = transport_hint(false).expect("text-only bundles explain themselves");
        assert!(
            hint.to_lowercase().contains("no audio"),
            "names the state: {hint}"
        );
        assert!(
            hint.to_lowercase().contains("re-voice"),
            "actionable: {hint}"
        );
    }

    #[test]
    fn position_label_formats_ordinal_offset_and_duration_and_hides_at_idle() {
        let session = fixture(true);
        let book = &session.book;

        let playing = PlayerState::Playing {
            para: ParagraphPos::new(2, 0),
            offset: 0.0,
            failures: Default::default(),
        };
        assert_eq!(
            position_label(&playing, book, None).as_deref(),
            Some("¶ 3/3 · 0:00"),
            "the ordinal is book-wide (the empty chapter counts nothing)"
        );

        let paused = PlayerState::Paused {
            para: ParagraphPos::new(0, 1),
            offset: 65.9,
            failures: Default::default(),
        };
        assert_eq!(
            position_label(&paused, book, Some(92.0)).as_deref(),
            Some("¶ 2/3 · 1:05 / 1:32")
        );

        assert_eq!(position_label(&PlayerState::idle(), book, Some(9.0)), None);
    }

    #[test]
    fn select_chapter_clamps_to_the_book() {
        let mut view = ReaderView::new(fixture(true), None);
        assert_eq!(view.chapter, 0);

        view.select_chapter(2);
        assert_eq!(view.chapter, 2);

        // Out of range settles on the last chapter, never panics.
        view.select_chapter(99);
        assert_eq!(view.chapter, 2);
    }

    #[test]
    fn select_chapter_on_an_empty_book_stays_at_zero() {
        let manifest = manifest(false);
        let book = BookIndex::new(&manifest, &[]);
        let view = ReaderView::new(
            ReaderSession {
                path: "/books/empty.taletrek".into(),
                book,
                meta: String::new(),
            },
            None,
        );
        let mut view = view;
        view.select_chapter(3);
        assert_eq!(view.chapter, 0);
    }

    #[test]
    fn narrated_sessions_spawn_a_playback_controller_text_only_do_not() {
        let narrated = ReaderView::new(fixture(true), None);
        assert!(
            narrated.playback.is_some(),
            "narrated bundles get the controller (engine thread + channels)"
        );

        let text_only = ReaderView::new(fixture(false), None);
        assert!(
            text_only.playback.is_none(),
            "text-only bundles spawn no audio thread at all"
        );
    }

    #[test]
    fn open_chapter_seeks_the_first_paragraph_and_anchors() {
        let (mut view, scripted) = playing_view(fixture(true), 0, 10.0);

        view.open_chapter(2);
        assert_eq!(view.chapter, 2, "the pane switches");
        let pb = view.playback.as_ref().unwrap();
        assert_eq!(active_paragraph(pb.state()), Some(ParagraphPos::new(2, 0)));
        let key2 = view.session.book.chapters[2].paragraphs[0]
            .segment_key
            .clone();
        assert!(
            scripted
                .loads()
                .iter()
                .any(|(k, off)| *k == key2 && *off == 0.0),
            "the chapter's first paragraph loads: {:?}",
            scripted.loads()
        );
        assert!(view.anchor, "an outline seek re-anchors following");

        // An empty chapter only switches the view.
        view.open_chapter(1);
        assert_eq!(view.chapter, 1);
        let pb = view.playback.as_ref().unwrap();
        assert_eq!(
            active_paragraph(pb.state()),
            Some(ParagraphPos::new(2, 0)),
            "no seek happened"
        );
    }

    #[test]
    fn render_paints_all_regions_under_both_themes() {
        for theme in [Theme::Dark, Theme::Sepia] {
            let ctx = egui::Context::default();
            theme::apply(&ctx, theme);

            // Populated, mid-book (chapter 2 selected), narrated — with
            // a scripted controller so the paint covers the live
            // transport: playing, positioned, one skipped paragraph.
            let mut view = ReaderView::new(fixture(true), None);
            view.select_chapter(2);
            let scripted = Arc::new(ScriptedTransport::new());
            let mut live = crate::gui::reader::playback::controller(scripted.clone());
            live.send(PlayerEvent::Play, &view.session.book);
            scripted.push(crate::gui::reader::audio::AudioEvent::Loaded {
                key: view.session.book.chapters[2].paragraphs[0]
                    .segment_key
                    .clone(),
                duration: 12.0,
            });
            live.send(PlayerEvent::Pause, &view.session.book);
            view.playback = Some(live);
            let _ = ctx.run_ui(egui::RawInput::default(), |ui| {
                view.render(ui, theme.tokens());
            });

            // The same book as text-only: hint path.
            let mut view = ReaderView::new(fixture(false), None);
            let _ = ctx.run_ui(egui::RawInput::default(), |ui| {
                view.render(ui, theme.tokens());
            });
        }
        // Painting header + outline + per-chapter pane + live transport
        // (and the text-only hint path) under the real theme/fonts
        // without panicking is the assertion — egui aborts on
        // layout/font misuse.
    }

    #[test]
    fn render_paints_idle_playing_and_paused_states_under_both_themes() {
        for theme in [Theme::Dark, Theme::Sepia] {
            let ctx = egui::Context::default();
            theme::apply(&ctx, theme);

            // Idle: no highlight, nothing follows, no scrub.
            let mut view = ReaderView::new(fixture(true), None);
            let scripted = Arc::new(ScriptedTransport::new());
            view.playback = Some(crate::gui::reader::playback::controller(scripted));
            view = paint(view, &ctx, vec![]);
            assert_eq!(view.probe.active_rect, None);
            assert!(view.following, "nothing disturbed the default");

            // Playing mid-chapter: highlighted + followed.
            let (mut view, _scripted) = playing_view(fixture(true), 1, 30.0);
            view = paint(view, &ctx, vec![]);
            assert_eq!(
                view.probe.active_rect,
                Some(view.probe.rects[1]),
                "the active paragraph paints highlighted"
            );
            assert!(view.following);

            // Paused: the highlight persists, the scrub renders.
            let (mut view, _scripted) = playing_view(fixture(true), 0, 30.0);
            view.playback
                .as_mut()
                .unwrap()
                .send(PlayerEvent::Pause, &view.session.book);
            view = paint(view, &ctx, vec![]);
            assert_eq!(view.probe.active_rect, Some(view.probe.rects[0]));
            assert!(view.probe.scrub_rect.is_some(), "the scrub slider renders");
        }
    }

    #[test]
    fn render_paints_an_empty_book_without_panicking() {
        for theme in [Theme::Dark, Theme::Sepia] {
            let ctx = egui::Context::default();
            theme::apply(&ctx, theme);
            let manifest = manifest(true);
            let book = BookIndex::new(&manifest, &[]);
            let mut view = ReaderView::new(
                ReaderSession {
                    path: "/books/empty.taletrek".into(),
                    book,
                    meta: "0 chapters · v · narrated".into(),
                },
                None,
            );
            let _ = ctx.run_ui(egui::RawInput::default(), |ui| {
                view.render(ui, theme.tokens());
            });
        }
    }

    #[test]
    fn clicking_a_paragraph_seeks_playback_and_the_highlight_agrees() {
        let ctx = egui::Context::default();
        theme::apply(&ctx, Theme::Dark);

        let (view, scripted) = playing_view(fixture(true), 0, 30.0);
        let view = paint(view, &ctx, vec![]);

        // Aim at the second paragraph's real geometry: press, release.
        let target = view.probe.rects[1].center();
        let view = paint(
            view,
            &ctx,
            vec![egui::Event::PointerMoved(target), pointer_down(target)],
        );
        let view = paint(view, &ctx, vec![pointer_up(target)]);

        let pb = view.playback.as_ref().unwrap();
        assert_eq!(
            active_paragraph(pb.state()),
            Some(ParagraphPos::new(0, 1)),
            "audio jumps to the clicked paragraph"
        );
        let key1 = view.session.book.chapters[0].paragraphs[1]
            .segment_key
            .clone();
        assert!(
            scripted
                .loads()
                .iter()
                .any(|(k, off)| *k == key1 && *off == 0.0),
            "the clicked paragraph's segment loads: {:?}",
            scripted.loads()
        );

        // The highlight agrees on the next paint, and following
        // re-anchored onto the click target.
        let view = paint(view, &ctx, vec![]);
        assert_eq!(view.probe.active_rect, Some(view.probe.rects[1]));
        assert!(view.following);
    }

    #[test]
    fn dragging_the_scrub_slider_seeks_within_the_paragraph_without_pausing() {
        let ctx = egui::Context::default();
        theme::apply(&ctx, Theme::Dark);

        let duration = 60.0;
        let (view, scripted) = playing_view(fixture(true), 0, duration);
        let view = paint(view, &ctx, vec![]);
        let rect = view
            .probe
            .scrub_rect
            .expect("the scrub slider renders while playing");

        // Press mid-track, drag right, release — one gesture.
        let start = egui::pos2(rect.left() + rect.width() * 0.5, rect.center().y);
        let end = egui::pos2(rect.left() + rect.width() * 0.8, rect.center().y);
        let view = paint(
            view,
            &ctx,
            vec![egui::Event::PointerMoved(start), pointer_down(start)],
        );
        let view = paint(view, &ctx, vec![egui::Event::PointerMoved(end)]);
        let view = paint(view, &ctx, vec![pointer_up(end)]);

        let key0 = view.session.book.chapters[0].paragraphs[0]
            .segment_key
            .clone();
        let scrubs: Vec<f64> = scripted
            .loads()
            .iter()
            .filter(|(k, _)| *k == key0)
            .map(|(_, off)| *off)
            .collect();
        assert_eq!(
            scrubs.len(),
            2,
            "one load (the play) + exactly one scrub commit: {scrubs:?}"
        );
        assert!(
            (duration * 0.6..=duration * 0.95).contains(&scrubs[1]),
            "the commit restarts near the release point (~80%): {scrubs:?}"
        );
        let pb = view.playback.as_ref().unwrap();
        assert!(
            matches!(pb.state(), PlayerState::Playing { .. }),
            "play/pause is unaffected by a scrub"
        );
    }

    #[test]
    fn following_tracks_playback_across_chapter_bounds_free_mode_does_not() {
        let ctx = egui::Context::default();
        theme::apply(&ctx, Theme::Dark);

        // Playing chapter 0; a chapter skip moves the active paragraph
        // to chapter 2 — the following pane switches chapters.
        let (mut view, _scripted) = playing_view(fixture(true), 0, 10.0);
        view.playback
            .as_mut()
            .unwrap()
            .send(PlayerEvent::NextChapter, &view.session.book);
        let view = paint(view, &ctx, vec![]);
        assert_eq!(view.chapter, 2, "following switches the pane");
        assert_eq!(
            view.probe.active_rect,
            Some(view.probe.rects[0]),
            "the highlight lands on chapter 2's first paragraph"
        );

        // Free mode: same jump, the pane stays where the user put it.
        let (mut view, _scripted) = playing_view(fixture(true), 0, 10.0);
        view.following = false;
        view.playback
            .as_mut()
            .unwrap()
            .send(PlayerEvent::NextChapter, &view.session.book);
        let view = paint(view, &ctx, vec![]);
        assert_eq!(view.chapter, 0, "free mode never hijacks the pane");
        assert_eq!(view.probe.active_rect, None, "nothing to highlight here");
    }

    #[test]
    fn a_user_scroll_pauses_following_until_the_paragraph_re_enters_view() {
        let ctx = egui::Context::default();
        theme::apply(&ctx, Theme::Dark);

        // Playing a few paragraphs into a tall chapter: following, the
        // active paragraph in view.
        let (view, _scripted) = playing_view(tall_fixture(), 2, 30.0);
        let view = paint(view, &ctx, vec![]);
        assert!(view.following);
        // The pointer must sit over the pane for the wheel to act on
        // it (egui routes scroll by hover).
        let over_pane = view.probe.view_rect.unwrap().center();

        // The user scrolls away: the active paragraph leaves view
        // without the paragraph changing — following pauses. (The
        // wheel lands on the next pass's layout, so assert after one
        // more paint.)
        let wheel = egui::Event::MouseWheel {
            // Line units: delivered whole, never time-smoothed — the
            // Point path low-passes by wall-clock dt and stalls headless.
            unit: egui::MouseWheelUnit::Line,
            delta: egui::vec2(0.0, -300.0),
            phase: egui::TouchPhase::Move,
            modifiers: egui::Modifiers::default(),
        };
        let view = paint(
            view,
            &ctx,
            vec![egui::Event::PointerMoved(over_pane), wheel.clone()],
        );
        let view = paint(
            view,
            &ctx,
            vec![egui::Event::PointerMoved(over_pane), wheel],
        );
        assert!(!view.following, "a user scroll away pauses following");
        let active = view.probe.active_rect.unwrap();
        let view_rect = view.probe.view_rect.unwrap();
        assert!(
            !active.intersects(view_rect),
            "fixture sanity: the active paragraph really left view"
        );

        // Playback advances while free: the user is not yanked.
        let mut view2 = view;
        view2
            .playback
            .as_mut()
            .unwrap()
            .send(PlayerEvent::NextParagraph, &view2.session.book);
        let view2 = paint(view2, &ctx, vec![]);
        assert!(!view2.following, "a natural advance does not re-anchor");

        // Scrolling back so the active paragraph re-enters view
        // resumes following.
        let back = egui::Event::MouseWheel {
            unit: egui::MouseWheelUnit::Line,
            delta: egui::vec2(0.0, 2000.0),
            phase: egui::TouchPhase::Move,
            modifiers: egui::Modifiers::default(),
        };
        let view2 = paint(
            view2,
            &ctx,
            vec![egui::Event::PointerMoved(over_pane), back.clone()],
        );
        let view2 = paint(
            view2,
            &ctx,
            vec![egui::Event::PointerMoved(over_pane), back],
        );
        assert!(view2.following, "re-entering view resumes following");
    }

    #[test]
    fn playback_advances_keep_the_active_paragraph_in_view() {
        let ctx = egui::Context::default();
        theme::apply(&ctx, Theme::Dark);

        // Start near the bottom of a tall chapter: the paragraph after
        // it sits below the fold, so the advance must scroll to keep
        // the highlight visible.
        let (view, _scripted) = playing_view(tall_fixture(), 38, 30.0);
        let mut view = paint(view, &ctx, vec![]);
        view.playback
            .as_mut()
            .unwrap()
            .send(PlayerEvent::NextParagraph, &view.session.book);
        let view = paint(view, &ctx, vec![]);
        // The scroll target applies at frame end; the next paint lays
        // the active paragraph inside the viewport.
        let view = paint(view, &ctx, vec![]);
        assert!(view.following);
        assert_eq!(view.probe.active_rect, Some(view.probe.rects[39]));
        let active = view.probe.active_rect.unwrap();
        let view_rect = view.probe.view_rect.unwrap();
        assert!(
            active.intersects(view_rect),
            "following keeps the active paragraph in view"
        );
    }

    // ---- position persistence (task 007) ------------------------------

    /// The fixture's book id — the storage slot the save hooks address.
    const BOOK_ID: &str = "bk_test";

    #[test]
    fn a_restored_position_opens_paused_at_its_chapter_and_paragraph() {
        let view = ReaderView::new(fixture(true), Some(Position::new(2, 0, 4.5)));
        assert_eq!(view.chapter, 2, "the pane opens on the saved chapter");
        assert_eq!(
            view.position(),
            Some(Position::new(2, 0, 4.5)),
            "the machine seeds paused at the saved paragraph"
        );

        // A stray position (corrupt storage, another edition) is
        // refused: idle machine, first chapter — start of book.
        let view = ReaderView::new(fixture(true), Some(Position::new(9, 9, 1.0)));
        assert_eq!(view.position(), None);
        assert_eq!(view.chapter, 0);

        // A text-only session never seeds (no machine to hold it).
        let view = ReaderView::new(fixture(false), Some(Position::new(0, 1, 2.0)));
        assert_eq!(view.position(), None);
        assert_eq!(view.chapter, 0);
    }

    #[test]
    fn the_first_paint_after_a_restore_scrolls_to_the_paragraph() {
        let ctx = egui::Context::default();
        theme::apply(&ctx, Theme::Dark);

        // A tall chapter with the restore point well below the fold.
        let view = ReaderView::new(tall_fixture(), Some(Position::new(0, 20, 3.0)));
        let view = paint(view, &ctx, vec![]);

        // The very first paint highlights the restored paragraph...
        assert_eq!(
            view.probe.active_rect,
            Some(view.probe.rects[20]),
            "the restored paragraph paints highlighted"
        );

        // ...and the follow scroll brings it into view. Headless, the
        // instant scroll applies a few frames late (egui's arrival
        // clock rides input time, which `run_ui` never advances), so
        // paint a bounded window and require it to land — in a live
        // window this is the very next frame.
        let mut view = view;
        let mut landed = false;
        for _ in 0..5 {
            view = paint(view, &ctx, vec![]);
            landed = view
                .probe
                .active_rect
                .is_some_and(|r| r.intersects(view.probe.view_rect.unwrap()));
            if landed {
                break;
            }
        }
        assert!(landed, "the restore scrolls its paragraph into view");
    }

    #[test]
    fn position_saves_on_advance_but_never_on_ticks_or_repaints() {
        let ctx = egui::Context::default();
        theme::apply(&ctx, Theme::Dark);

        let (view, scripted) = playing_view(fixture(true), 0, 30.0);
        let key0 = view.session.book.chapters[0].paragraphs[0]
            .segment_key
            .clone();
        let key1 = view.session.book.chapters[0].paragraphs[1]
            .segment_key
            .clone();

        // First paint: the start position lands in the store.
        let view = paint(view, &ctx, vec![]);
        assert_eq!(
            super::super::position_store::load(&ctx, BOOK_ID),
            Some(Position::new(0, 0, 0.0))
        );

        // Ticks move audio time, not paragraphs — repaints ride along:
        // neither may write, or playback becomes a save storm.
        scripted.push(crate::gui::reader::audio::AudioEvent::Tick {
            key: key0,
            offset: 17.3,
        });
        let mut view = paint(view, &ctx, vec![]);
        view = paint(view, &ctx, vec![]);
        assert_eq!(
            super::super::position_store::load(&ctx, BOOK_ID),
            Some(Position::new(0, 0, 0.0)),
            "ticks and repaints must not save"
        );

        // An advance moves the paragraph: the store moves with it.
        view.playback
            .as_mut()
            .unwrap()
            .send(PlayerEvent::NextParagraph, &view.session.book);
        let view = paint(view, &ctx, vec![]);
        assert_eq!(
            super::super::position_store::load(&ctx, BOOK_ID),
            Some(Position::new(0, 1, 0.0)),
            "the advance saves at the new paragraph"
        );

        // Offset churn on the new paragraph stays out of the store too.
        scripted.push(crate::gui::reader::audio::AudioEvent::Tick {
            key: key1,
            offset: 8.0,
        });
        let _view = paint(view, &ctx, vec![]);
        assert_eq!(
            super::super::position_store::load(&ctx, BOOK_ID),
            Some(Position::new(0, 1, 0.0))
        );
    }

    #[test]
    fn save_position_writes_the_machine_where_it_stands() {
        let ctx = egui::Context::default();
        theme::apply(&ctx, Theme::Dark);

        // Paused mid-paragraph (the reader-exit moment): the exit save
        // captures paragraph and offset together.
        let (mut view, _scripted) = playing_view(fixture(true), 1, 30.0);
        view.playback
            .as_mut()
            .unwrap()
            .send(PlayerEvent::Pause, &view.session.book);
        view.save_position(&ctx);
        assert_eq!(
            super::super::position_store::load(&ctx, BOOK_ID),
            Some(Position::new(0, 1, 0.0))
        );

        // An idle machine (finished or never played) writes nothing —
        // a prior position must survive untouched.
        let idle_view = ReaderView::new(fixture(true), None);
        idle_view.save_position(&ctx);
        assert_eq!(
            super::super::position_store::load(&ctx, BOOK_ID),
            Some(Position::new(0, 1, 0.0)),
            "an idle exit does not clobber the saved place"
        );

        // A text-only session has nothing to persist either.
        let quiet = ReaderView::new(fixture(false), None);
        quiet.save_position(&ctx);
        assert_eq!(
            super::super::position_store::load(&ctx, BOOK_ID),
            Some(Position::new(0, 1, 0.0))
        );
    }
}
