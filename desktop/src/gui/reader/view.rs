//! The reader screen's egui surface (task 004): title/meta header,
//! chapter outline, per-chapter text pane, and the transport placeholder.
//!
//! Presentational (the views' pattern): it renders the [`ReaderSession`]
//! it owns and returns user intents ([`ReaderAction::Back`]) — no queue,
//! executor, or audio knowledge. The whole book is never one scroll:
//! the outline switches chapters and the pane renders exactly one
//! (web-reader precedent; the big-book mitigation). Playback arrives in
//! task 005 — until then the transport is a disabled placeholder, with an
//! explanatory hint on text-only bundles (they must read *fully* here).
//!
//! Type note: book *content* renders in the story face (XCharter) — the
//! reading typeface — while chrome (outline, transport, meta) stays in
//! the machine face. The `desktop-ux-refresh` type rule pinned the
//! machine face for converter chrome before a reader existed; a reading
//! app setting book text in monospace would invert the identity.

use eframe::egui;

use super::session::ReaderSession;
use crate::gui::theme::{self, Tokens};

/// The reader's paragraph text size in pt — one step above the 14 pt
/// chrome base, book-text scale.
const BODY_PT: f32 = 16.0;

/// The reader header's book-title size in pt (the heading scale, serif).
const TITLE_PT: f32 = 18.0;

/// The outline panel's width in points.
const OUTLINE_WIDTH: f32 = 200.0;

/// What the reader screen asks the shell to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReaderAction {
    /// Return to the converter screen (queue state is the executor's —
    /// untouched by construction).
    Back,
}

/// The reader screen: one open session plus the view-local state (the
/// selected chapter). Grows the sync UX in task 006.
pub(crate) struct ReaderView {
    /// The opened bundle (open-flow output).
    session: ReaderSession,
    /// The chapter the text pane shows (index into `session.book.chapters`).
    chapter: usize,
}

impl ReaderView {
    /// A fresh view over an opened session, starting at the first chapter.
    pub(crate) fn new(session: ReaderSession) -> Self {
        Self {
            session,
            chapter: 0,
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

    /// Paint the reader screen inside `ui`: header (top), transport
    /// placeholder (bottom), outline (left), text pane (center).
    /// Returns the intent if the user asked to leave.
    pub(crate) fn render(&mut self, ui: &mut egui::Ui, t: Tokens) -> Option<ReaderAction> {
        let mut action = None;

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
        action
    }

    /// The chapter outline: one token-styled row per chapter, the current
    /// chapter picked out in accent. Clicking switches the text pane.
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
                                self.select_chapter(*idx);
                            }
                        }
                    });
            });
    }

    /// The text pane: exactly one chapter (the outline switches), laid
    /// out in the story face — the whole book is never one scroll. The
    /// scroll is keyed by chapter id, so each chapter keeps its own
    /// position across switches.
    fn text_pane(&self, ui: &mut egui::Ui, t: Tokens) {
        egui::CentralPanel::default().show(ui, |ui| {
            let Some(chapter) = self.session.book.chapters.get(self.chapter) else {
                ui.label(
                    egui::RichText::new("This bundle has no chapters.")
                        .small()
                        .color(t.muted),
                );
                return;
            };
            egui::ScrollArea::vertical()
                .auto_shrink(false)
                .id_salt(chapter.id.as_str())
                .show(ui, |ui| {
                    ui.add_space(10.0);
                    ui.label(
                        egui::RichText::new(&chapter.title)
                            .font(egui::FontId::new(TITLE_PT, theme::story_bold_family()))
                            .color(t.fg),
                    );
                    ui.add_space(10.0);
                    if chapter.paragraphs.is_empty() {
                        ui.label(
                            egui::RichText::new("This chapter has no text.")
                                .small()
                                .color(t.muted),
                        );
                    }
                    for paragraph in &chapter.paragraphs {
                        ui.label(
                            egui::RichText::new(&paragraph.text)
                                .font(egui::FontId::new(BODY_PT, theme::story_family()))
                                .color(t.fg),
                        );
                        ui.add_space(10.0);
                    }
                });
        });
    }

    /// The transport placeholder (task 005 wires the engine): disabled
    /// ASCII controls on surface chrome, with the explanatory hint when
    /// the bundle carries no audio — a text-only book must explain its
    /// own silence.
    fn transport(&self, ui: &mut egui::Ui, t: Tokens) {
        egui::Panel::bottom("reader-transport")
            .resizable(false)
            .frame(
                egui::Frame::default()
                    .fill(t.surface)
                    .inner_margin(egui::Margin::symmetric(8, 4)),
            )
            .show(ui, |ui| {
                ui.horizontal(|ui| {
                    for label in ["|<", "<", "Play", ">", ">|"] {
                        ui.add_enabled(false, egui::Button::new(label));
                    }
                    if let Some(hint) = transport_hint(self.session.book.audio_present) {
                        ui.label(egui::RichText::new(hint).small().color(t.muted));
                    }
                });
            });
    }
}

/// The transport placeholder's hint: `None` when the bundle carries
/// audio (the buttons are disabled until task 005 wires the engine — no
/// copy needed), and the explanatory sentence when it doesn't.
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

#[cfg(test)]
mod tests {
    use super::*;
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
    fn select_chapter_clamps_to_the_book() {
        let mut view = ReaderView::new(fixture(true));
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
        let view = ReaderView::new(ReaderSession {
            path: "/books/empty.taletrek".into(),
            book,
            meta: String::new(),
        });
        let mut view = view;
        view.select_chapter(3);
        assert_eq!(view.chapter, 0);
    }

    #[test]
    fn render_paints_all_regions_under_both_themes() {
        for theme in [Theme::Dark, Theme::Sepia] {
            let ctx = egui::Context::default();
            theme::apply(&ctx, theme);

            // Populated, mid-book (chapter 2 selected), narrated.
            let mut view = ReaderView::new(fixture(true));
            view.select_chapter(2);
            let _ = ctx.run_ui(egui::RawInput::default(), |ui| {
                view.render(ui, theme.tokens());
            });

            // The same book as text-only: hint path.
            let mut view = ReaderView::new(fixture(false));
            let _ = ctx.run_ui(egui::RawInput::default(), |ui| {
                view.render(ui, theme.tokens());
            });
        }
        // Painting header + outline + per-chapter pane + placeholder
        // transport under the real theme/fonts without panicking is the
        // assertion — egui aborts on layout/font misuse.
    }

    #[test]
    fn render_paints_an_empty_book_without_panicking() {
        for theme in [Theme::Dark, Theme::Sepia] {
            let ctx = egui::Context::default();
            theme::apply(&ctx, theme);
            let manifest = manifest(true);
            let book = BookIndex::new(&manifest, &[]);
            let mut view = ReaderView::new(ReaderSession {
                path: "/books/empty.taletrek".into(),
                book,
                meta: "0 chapters · v · narrated".into(),
            });
            let _ = ctx.run_ui(egui::RawInput::default(), |ui| {
                view.render(ui, theme.tokens());
            });
        }
    }
}
