//! The voice picker (T8, restyled by `desktop-ux-refresh`): the curated
//! catalog as line-separated rows.
//!
//! One voice per row: an accent `❯` prefix and full-strength name mark the
//! selection (unselected names sit a step quieter), the id stays small
//! muted mono with quality + size joined into one muted meta run, and
//! already-cached voices carry an accent-soft "downloaded" chip on the
//! name line. The whole row is the radio hit target. Selecting a voice
//! does **not** download it — the model is acquired lazily by the first job
//! that uses it (the worker's `resolve_voice` inside the job thread,
//! download progress shown on that job's row), so the picker stays a pure
//! choice and the network stays off the UI thread.
//!
//! The pure helpers ([`is_voice_cached`], [`size_label`], [`row_meta`],
//! [`chip_fill`]) are headless-testable; only [`render`] touches egui.

use std::path::Path;

use eframe::egui;

use taletrek_worker::{Voice, VoiceQuality, CURATED_VOICES};

use crate::gui::theme::Tokens;

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

/// How much accent the "downloaded" chip's wash carries — 15 % into the
/// panel ground: soft enough to read as a tint, strong enough to read as
/// phosphor in both themes.
const CHIP_MIX: f32 = 0.15;

/// The "downloaded" chip's fill: the accent mixed [`CHIP_MIX`] into the
/// panel ground — an opaque accent-soft tint, with the chip's text at
/// full-strength accent (the identity's chip rule).
pub(crate) fn chip_fill(t: Tokens) -> egui::Color32 {
    let mix = |from: u8, to: u8| {
        (f32::from(from) * (1.0 - CHIP_MIX) + f32::from(to) * CHIP_MIX).round() as u8
    };
    let [br, bg, bb, _] = t.bg.to_array();
    let [ar, ag, ab, _] = t.accent.to_array();
    egui::Color32::from_rgb(mix(br, ar), mix(bg, ag), mix(bb, ab))
}

/// The row's one muted meta run — quality and size joined with the same
/// `·` the status line uses (`medium · ~60 MiB`), replacing the old grid's
/// two separate columns.
pub(crate) fn row_meta(voice: &Voice) -> String {
    format!(
        "{} · {}",
        quality_label(voice.quality),
        size_label(voice.size_bytes)
    )
}

/// Render the catalog as line-separated rows — hairline separators
/// between voices, no grid stripes. `t` is the identity palette;
/// `selected` is the current default voice id (its row gets the accent
/// `❯` + full-strength name); `cache_dir` flags already-downloaded voices
/// with the chip (`None` = no discoverable cache dir — nothing is
/// flagged). Returns the id the user newly picked, if any — the caller
/// persists it as the default and stamps it onto subsequently enqueued
/// jobs. Radio semantics: any row click picks that voice (clicking the
/// already-selected row is a no-op), so the pick survives via the
/// caller's persistence.
pub fn render(
    ui: &mut egui::Ui,
    t: Tokens,
    selected: &str,
    cache_dir: Option<&Path>,
) -> Option<String> {
    let mut picked = None;
    for (index, voice) in CURATED_VOICES.iter().enumerate() {
        if index > 0 {
            ui.separator();
        }
        if let Some(id) = row(ui, t, voice, selected, cache_dir) {
            picked = Some(id);
        }
    }
    picked
}

/// One voice row: the name line (marker + name left, chip right-aligned)
/// over the id + meta line (the id yields first — ellipsizes — so the
/// meta run never wraps or clips). The whole row rect is the radio hit
/// target; hovering washes it elevated so the row reads as clickable.
fn row(
    ui: &mut egui::Ui,
    t: Tokens,
    voice: &Voice,
    selected: &str,
    cache_dir: Option<&Path>,
) -> Option<String> {
    let is_selected = voice.id == selected;
    let downloaded = cache_dir.is_some_and(|dir| is_voice_cached(dir, voice.id));

    // Hover-wash slot: reserve a shape index now, fill it once the row's
    // rect is known — `set` replaces in place, so the wash stays behind
    // the row's text no matter when it is painted.
    let wash_idx = ui.painter().add(egui::Shape::Noop);
    let rendered = ui.scope(|ui| {
        ui.set_min_width(ui.available_width());

        // Name line: the marker slot always advances (transparent when
        // unselected) so every name aligns on the same left edge.
        ui.horizontal(|ui| {
            ui.label(egui::RichText::new("❯").color(if is_selected {
                t.accent
            } else {
                egui::Color32::TRANSPARENT
            }));
            ui.label(egui::RichText::new(voice.name).color(if is_selected {
                t.fg
            } else {
                t.muted
            }));
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if downloaded {
                    egui::Frame::default()
                        .fill(chip_fill(t))
                        .corner_radius(egui::CornerRadius::same(3))
                        .inner_margin(egui::Margin::symmetric(5, 1))
                        .show(ui, |ui| {
                            ui.label(egui::RichText::new("downloaded").small().color(t.accent));
                        });
                }
            });
        });

        // Id + meta line: measure the meta run first, then give the id
        // exactly the width that's left — ids ellipsize, meta stays whole.
        let meta = row_meta(voice);
        let meta_width = {
            let font = egui::TextStyle::Small.resolve(ui.style());
            ui.painter()
                .layout(meta.clone(), font, t.muted, f32::INFINITY)
                .size()
                .x
        };
        let spacing = ui.spacing().item_spacing.x;
        ui.horizontal(|ui| {
            let id_budget = (ui.available_width() - meta_width - spacing).max(30.0);
            ui.add_sized(
                egui::vec2(id_budget, ui.text_style_height(&egui::TextStyle::Small)),
                egui::Label::new(
                    egui::RichText::new(voice.id)
                        .small()
                        .monospace()
                        .color(t.muted),
                )
                .truncate(),
            );
            ui.label(egui::RichText::new(meta).small().color(t.muted));
        });
    });

    let rect = rendered.response.rect;
    let click = ui.interact(
        rect,
        ui.id().with(("voice-row", voice.id)),
        egui::Sense::click(),
    );
    ui.painter().set(
        wash_idx,
        egui::Shape::rect_filled(
            rect.expand(2.0),
            egui::CornerRadius::same(3),
            if click.hovered() {
                t.elevated
            } else {
                egui::Color32::TRANSPARENT
            },
        ),
    );
    if click.clicked() && !is_selected {
        Some(voice.id.to_string())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::gui::theme;

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

    #[test]
    fn row_meta_joins_quality_and_size_into_one_run() {
        let hfc = CURATED_VOICES[0]; // medium, 63_201_294 bytes
        assert_eq!(row_meta(&hfc), "medium · ~60 MiB");

        let synthetic = Voice {
            id: "x-low",
            name: "X",
            quality: VoiceQuality::Low,
            size_bytes: 3 * 1024 * 1024,
            language: "en_US",
        };
        assert_eq!(row_meta(&synthetic), "low · ~3 MiB");
    }

    #[test]
    fn chip_fill_is_a_soft_accent_wash_between_bg_and_accent() {
        for theme in [theme::Theme::Dark, theme::Theme::Sepia] {
            let t = theme.tokens();
            let fill = chip_fill(t);

            assert_ne!(
                fill, t.bg,
                "{theme:?}: chip must not vanish into the ground"
            );
            assert_ne!(
                fill, t.accent,
                "{theme:?}: chip must stay soft, not full accent"
            );

            // Every channel of the wash lies between ground and accent.
            let [fr, fgc, fb, _] = fill.to_array();
            let [br, bgr, bb, _] = t.bg.to_array();
            let [ar, agc, ab, _] = t.accent.to_array();
            for (f, b, a) in [(fr, br, ar), (fgc, bgr, agc), (fb, bb, ab)] {
                let (lo, hi) = (b.min(a), b.max(a));
                assert!(
                    (lo..=hi).contains(&f),
                    "{theme:?}: channel {f} outside the [{lo}, {hi}] wash range"
                );
            }
        }
    }

    #[test]
    fn rows_paint_under_both_themes_at_panel_and_narrow_widths() {
        let dir = tempfile::tempdir().unwrap();
        // One cached voice (both halves of the pair) exercises the chip
        // path; the rest render uncached.
        let cached = CURATED_VOICES[0].id;
        touch(dir.path(), &format!("{cached}.onnx"));
        touch(dir.path(), &format!("{cached}.json"));

        for theme in [theme::Theme::Dark, theme::Theme::Sepia] {
            let ctx = egui::Context::default();
            theme::apply(&ctx, theme);
            let t = theme.tokens();
            // The side panel's default width, then a squeezed panel that
            // forces the id's ellipsis path under real layout.
            for width in [300.0, 200.0] {
                let mut picked = None;
                let _ = ctx.run_ui(egui::RawInput::default(), |ui| {
                    egui::CentralPanel::default().show(ui, |ui| {
                        ui.set_max_width(width);
                        picked = render(ui, t, CURATED_VOICES[1].id, Some(dir.path()));
                    });
                });
                assert_eq!(
                    picked, None,
                    "{theme:?} @ {width}: no pointer input headless — no pick reported"
                );
            }
        }
        // Painting every row (selected + chip, unselected, cached +
        // uncached, wide + ellipsizing) under the real theme/fonts without
        // panicking is the assertion — egui aborts on layout/font misuse.
    }
}
