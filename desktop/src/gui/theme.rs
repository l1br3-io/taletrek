//! The TaleTrek desktop identity: two themes pinned to the web tokens and
//! the two bundled type faces (effort `desktop-ux-refresh`).
//!
//! Everything here is pure data + constructors — headless-testable without
//! a window; only [`apply`] touches a live egui context (the views'
//! pattern). The web app is the authority: every hex mirrors
//! `web/src/styles/index.css`, so a user who knows the site recognizes the
//! app within a second of opening it.
//!
//! # Font provenance (re-source carefully)
//!
//! The four cuts are embedded with `include_bytes!` from
//! `desktop/assets/fonts/`, so release binaries render identically on any
//! machine — no system-font dependence. Pinned sources and sha256s:
//!
//! | File | Source | sha256 |
//! | --- | --- | --- |
//! | `JetBrainsMono-Regular.ttf` | JetBrains/JetBrainsMono @ v2.304, `fonts/ttf/` | `a0bf60ef0f83c5ed4d7a75d45838548b1f6873372dfac88f71804491898d138f` |
//! | `JetBrainsMono-Bold.ttf` | JetBrains/JetBrainsMono @ v2.304, `fonts/ttf/` | `5590990c82e097397517f275f430af4546e1c45cff408bde4255dad142479dcb` |
//! | `XCharter-Regular.otf` | CTAN `fonts/xcharter.zip` v1.26 (2024-06-18), `opentype/XCharter-Roman.otf` | `e5d22b0f417a0a3e22ee2d7ef10d2e8bba1397066ac3de44e3e3b34e6e56c601` |
//! | `XCharter-Bold.otf` | CTAN `fonts/xcharter.zip` v1.26 (2024-06-18), `opentype/XCharter-Bold.otf` | `baf595556bbd65749a83b41034c900a8d7f8f5b2a1aa24314319501fdcacce9b` |
//!
//! Two spec-assumption corrections, recorded here so nobody re-trips:
//!
//! - **google/fonts does not carry these cuts.** It hosts only the
//!   variable `JetBrainsMono[wght].ttf` (no statics), and egui 0.35
//!   cannot select named instances of a variable font — static cuts are
//!   required, hence the JetBrains upstream repo. XCharter is not on
//!   Google Fonts at all; CTAN is the canonical home.
//! - **XCharter is OFL-adjacent but not OFL** — it inherits the
//!   permissive Bitstream Charter license (use/modify/redistribute for
//!   any purpose; the notice must ship with the fonts). The notice lives
//!   at `assets/fonts/LICENSE-XCharter.txt` and must stay beside the
//!   `.otf` files. The cuts keep their honest `.otf` extension (CFF
//!   outlines — epaint 0.35 parses CFF fine).
//!
//! # The egui 0.35 weight trap
//!
//! `epaint::FontId` has no weight field (upstream TODO) and
//! `RichText::strong` only deepens the color — there is no way to *ask*
//! for bold glyphs. Bold is therefore reachable only through dedicated
//! font families: [`story_bold_family`] (XCharter Bold) and
//! [`machine_bold_family`] (JetBrains Mono Bold). Styling tasks use
//! those constants for the spec's "serif titles 18 bold" (Story) and
//! "top-bar brand 15 bold" (Machine).

use std::sync::Arc;

use eframe::egui;

/// egui-storage key for the persisted theme (additive; first run = dark).
pub const THEME_STORAGE_KEY: &str = "taletrek.settings.theme";

/// The two TaleTrek themes — hexes mirror `web/src/styles/index.css`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Theme {
    /// "Phosphor ink" — warm near-black with amber accent (the default).
    #[default]
    Dark,
    /// "Green screen paper" — phosphor green on tractor-feed cream.
    Sepia,
}

/// The TaleTrek palette for one [`Theme`] — every value pinned to the web
/// CSS tokens (including `warning`, which the web carries and the app
/// needs for `Visuals::warn_fg_color`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Tokens {
    /// Window/panel ground.
    pub bg: egui::Color32,
    /// One step up from bg — strips, code fields, text-edit wells.
    pub surface: egui::Color32,
    /// Two steps up — hovered fills, popovers.
    pub elevated: egui::Color32,
    /// Primary text.
    pub fg: egui::Color32,
    /// Secondary text and hints.
    pub muted: egui::Color32,
    /// Hairline strokes and widget outlines.
    pub line: egui::Color32,
    /// The phosphor: amber in dark, green in sepia.
    pub accent: egui::Color32,
    /// Success/finished state color.
    pub success: egui::Color32,
    /// Failure state color.
    pub danger: egui::Color32,
    /// Caution text (web `--tt-warning`).
    pub warning: egui::Color32,
}

impl Theme {
    /// This theme's palette — the exact web hexes.
    #[must_use]
    pub fn tokens(self) -> Tokens {
        let (bg, surface, elevated, fg, muted, line, accent, success, danger, warning) = match self
        {
            Self::Dark => (
                0x0e0d0b, // bg — warm near-black
                0x16140f, // surface
                0x211e16, // elevated
                0xe8e4d8, // fg
                0x8a8474, // muted
                0x2a2620, // line
                0xe8a838, // accent — amber
                0x7a9a5a, // success
                0xc6553e, // danger
                0xe8a838, // warning (web dark: same as accent)
            ),
            Self::Sepia => (
                0xf2ede0, // bg — tractor-feed cream
                0xe8e1d0, // surface
                0xddd4be, // elevated
                0x2a3328, // fg
                0x6a7560, // muted
                0xc9c0a8, // line
                0x4a7a3a, // accent — phosphor green
                0x4a7a3a, // success (web pins green for both roles)
                0xa04030, // danger
                0x8a6a1a, // warning
            ),
        };
        let c = |hex: u32| {
            egui::Color32::from_rgb(
                ((hex >> 16) & 0xff) as u8,
                ((hex >> 8) & 0xff) as u8,
                (hex & 0xff) as u8,
            )
        };
        Tokens {
            bg: c(bg),
            surface: c(surface),
            elevated: c(elevated),
            fg: c(fg),
            muted: c(muted),
            line: c(line),
            accent: c(accent),
            success: c(success),
            danger: c(danger),
            warning: c(warning),
        }
    }

    /// The persistence encoding — the string stored under
    /// [`THEME_STORAGE_KEY`].
    #[must_use]
    pub fn persist_name(self) -> &'static str {
        match self {
            Self::Dark => "dark",
            Self::Sepia => "sepia",
        }
    }

    /// Decode a persisted value; anything absent or unrecognized (a
    /// future theme name, corrupted storage) resolves to the dark
    /// default, so the app always opens recognizable.
    #[must_use]
    pub fn from_persisted(raw: Option<&str>) -> Self {
        match raw {
            Some("sepia") => Self::Sepia,
            _ => Self::Dark,
        }
    }

    /// Whether this theme renders dark (drives egui's dark/light mode).
    #[must_use]
    pub const fn is_dark(self) -> bool {
        matches!(self, Self::Dark)
    }
}

/// The story family — XCharter Regular. Book titles and the empty-state
/// headline only (see the spec's type rules).
#[must_use]
pub fn story_family() -> egui::FontFamily {
    egui::FontFamily::Name("Story".into())
}

/// The story family's bold cut — XCharter Bold (see the weight trap above).
#[must_use]
pub fn story_bold_family() -> egui::FontFamily {
    egui::FontFamily::Name("Story-Bold".into())
}

/// The machine face's bold cut — JetBrains Mono Bold (the brand mark).
#[must_use]
pub fn machine_bold_family() -> egui::FontFamily {
    egui::FontFamily::Name("Machine-Bold".into())
}

/// The embedded JetBrains Mono Regular cut (the machine face).
const JETBRAINS_MONO_REGULAR_TTF: &[u8] =
    include_bytes!("../../assets/fonts/JetBrainsMono-Regular.ttf");
/// The embedded JetBrains Mono Bold cut.
const JETBRAINS_MONO_BOLD_TTF: &[u8] = include_bytes!("../../assets/fonts/JetBrainsMono-Bold.ttf");
/// The embedded XCharter Regular cut (CFF OpenType).
const XCHARTER_REGULAR_OTF: &[u8] = include_bytes!("../../assets/fonts/XCharter-Regular.otf");
/// The embedded XCharter Bold cut (CFF OpenType).
const XCHARTER_BOLD_OTF: &[u8] = include_bytes!("../../assets/fonts/XCharter-Bold.otf");

/// Font-data name for the machine face's regular cut.
const CUT_JETBRAINS_REGULAR: &str = "JetBrainsMono-Regular";
/// Font-data name for the machine face's bold cut.
const CUT_JETBRAINS_BOLD: &str = "JetBrainsMono-Bold";
/// Font-data name for the story face's regular cut.
const CUT_XCHARTER_REGULAR: &str = "XCharter-Regular";
/// Font-data name for the story face's bold cut.
const CUT_XCHARTER_BOLD: &str = "XCharter-Bold";

/// Install a TaleTrek primary in front of a family's existing fallbacks
/// (the builtin emoji/symbol faces must stay reachable behind our cuts).
fn set_primary(list: &mut Vec<String>, cut: &str) {
    list.retain(|name| name != cut);
    list.insert(0, cut.to_owned());
}

/// The TaleTrek font stack: both builtin families become JetBrains Mono
/// (the machine face), XCharter installs as the Story family, and the
/// bold cuts get dedicated families (egui 0.35 has no weight selection).
/// The builtin emoji/symbol fallbacks stay behind every primary so prompt
/// glyphs (`❯`, `▊`, `◐`) and emoji keep rendering.
#[must_use]
pub fn font_definitions() -> egui::FontDefinitions {
    let mut fonts = egui::FontDefinitions::default();

    fonts.font_data.insert(
        CUT_JETBRAINS_REGULAR.to_owned(),
        Arc::new(egui::FontData::from_static(JETBRAINS_MONO_REGULAR_TTF)),
    );
    fonts.font_data.insert(
        CUT_JETBRAINS_BOLD.to_owned(),
        Arc::new(egui::FontData::from_static(JETBRAINS_MONO_BOLD_TTF)),
    );
    fonts.font_data.insert(
        CUT_XCHARTER_REGULAR.to_owned(),
        Arc::new(egui::FontData::from_static(XCHARTER_REGULAR_OTF)),
    );
    fonts.font_data.insert(
        CUT_XCHARTER_BOLD.to_owned(),
        Arc::new(egui::FontData::from_static(XCHARTER_BOLD_OTF)),
    );

    // The builtin symbol/emoji fallback chain (everything the default
    // Proportional family offered besides its primary) — reused behind
    // every TaleTrek primary.
    let fallbacks: Vec<String> = fonts
        .families
        .get(&egui::FontFamily::Proportional)
        .cloned()
        .unwrap_or_default();

    if let Some(list) = fonts.families.get_mut(&egui::FontFamily::Proportional) {
        set_primary(list, CUT_JETBRAINS_REGULAR);
    }
    if let Some(list) = fonts.families.get_mut(&egui::FontFamily::Monospace) {
        set_primary(list, CUT_JETBRAINS_REGULAR);
    }

    let story_stack = |cut: &str| {
        let mut list = vec![cut.to_owned()];
        list.extend(fallbacks.iter().cloned());
        list
    };
    fonts
        .families
        .insert(story_family(), story_stack(CUT_XCHARTER_REGULAR));
    fonts
        .families
        .insert(story_bold_family(), story_stack(CUT_XCHARTER_BOLD));
    fonts
        .families
        .insert(machine_bold_family(), story_stack(CUT_JETBRAINS_BOLD));

    fonts
}

/// One widget-state's visuals from tokens: fill colors, hairline stroke,
/// foreground, and the spec's 3 px widget rounding.
fn widget_visuals(
    weak_bg_fill: egui::Color32,
    bg_fill: egui::Color32,
    stroke: egui::Color32,
    fg: egui::Color32,
) -> egui::style::WidgetVisuals {
    egui::style::WidgetVisuals {
        bg_fill,
        weak_bg_fill,
        bg_stroke: egui::Stroke::new(1.0, stroke),
        corner_radius: egui::CornerRadius::same(3),
        fg_stroke: egui::Stroke::new(1.0, fg),
        expansion: 0.0,
    }
}

/// Widget-level visuals for one [`Theme`] — panels, buttons, hover,
/// selection, 3–4 px rounding, all derived from the tokens.
#[must_use]
pub fn visuals(theme: Theme) -> egui::Visuals {
    let t = theme.tokens();
    let mut v = if theme.is_dark() {
        egui::Visuals::dark()
    } else {
        egui::Visuals::light()
    };

    v.dark_mode = theme.is_dark();
    v.panel_fill = t.bg;
    v.window_fill = t.bg;
    v.faint_bg_color = t.surface;
    v.extreme_bg_color = t.surface;
    v.text_edit_bg_color = Some(t.surface);
    v.code_bg_color = t.surface;
    v.hyperlink_color = t.accent;
    v.error_fg_color = t.danger;
    v.warn_fg_color = t.warning;
    v.selection.bg_fill = t.accent;
    v.selection.stroke = egui::Stroke::new(1.0, t.bg);
    v.window_corner_radius = egui::CornerRadius::same(4);
    v.menu_corner_radius = egui::CornerRadius::same(4);
    v.window_stroke = egui::Stroke::new(1.0, t.line);

    // Non-interactive chrome: flat on bg, hairline outline, plain fg.
    v.widgets.noninteractive = widget_visuals(egui::Color32::TRANSPARENT, t.bg, t.line, t.fg);
    // Resting controls sit one step up; hover/active light on elevated
    // with the phosphor picking out the active edge.
    v.widgets.inactive = widget_visuals(t.surface, t.surface, t.line, t.fg);
    v.widgets.hovered = widget_visuals(t.elevated, t.elevated, t.accent, t.fg);
    v.widgets.active = widget_visuals(t.elevated, t.elevated, t.accent, t.fg);
    v.widgets.open = widget_visuals(t.elevated, t.elevated, t.accent, t.fg);

    v
}

/// The full style for one [`Theme`]: visuals plus the spec's type scale
/// (UI base 14 · small 12.5 · heading 18 — serif/brand specifics are set
/// per-element via the family constructors above).
#[must_use]
pub fn style(theme: Theme) -> egui::Style {
    use egui::FontFamily::Proportional;
    use egui::TextStyle;
    let text_styles = [
        (TextStyle::Heading, egui::FontId::new(18.0, Proportional)),
        (TextStyle::Body, egui::FontId::new(14.0, Proportional)),
        (TextStyle::Button, egui::FontId::new(14.0, Proportional)),
        (TextStyle::Small, egui::FontId::new(12.5, Proportional)),
        (TextStyle::Monospace, egui::FontId::new(14.0, Proportional)),
    ]
    .into();
    egui::Style {
        visuals: visuals(theme),
        text_styles,
        ..Default::default()
    }
}

/// Install a theme on a live context: select the egui dark/light mode,
/// install the style, and register the fonts. The single egui-mutating
/// entry point (everything else is pure).
pub fn apply(ctx: &egui::Context, theme: Theme) {
    let egui_theme = match theme {
        Theme::Dark => egui::Theme::Dark,
        Theme::Sepia => egui::Theme::Light,
    };
    ctx.set_theme(egui_theme);
    ctx.set_style_of(egui_theme, style(theme));
    ctx.set_fonts(font_definitions());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(hex: u32) -> egui::Color32 {
        egui::Color32::from_rgb(
            ((hex >> 16) & 0xff) as u8,
            ((hex >> 8) & 0xff) as u8,
            (hex & 0xff) as u8,
        )
    }

    /// WCAG relative luminance (sRGB channels linearized).
    fn luminance(color: egui::Color32) -> f64 {
        let chan = |v: u8| {
            let c = f64::from(v) / 255.0;
            if c <= 0.039_28 {
                c / 12.92
            } else {
                ((c + 0.055) / 1.055).powf(2.4)
            }
        };
        let [r, g, b, _] = color.to_array();
        0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b)
    }

    /// WCAG contrast ratio between two colors (≥ 1.0).
    fn contrast(a: egui::Color32, b: egui::Color32) -> f64 {
        let (la, lb) = (luminance(a), luminance(b));
        let (hi, lo) = if la >= lb { (la, lb) } else { (lb, la) };
        (hi + 0.05) / (lo + 0.05)
    }

    #[test]
    fn token_tables_match_the_web_hexes_exactly() {
        let dark = Theme::Dark.tokens();
        assert_eq!(dark.bg, c(0x0e0d0b));
        assert_eq!(dark.surface, c(0x16140f));
        assert_eq!(dark.elevated, c(0x211e16));
        assert_eq!(dark.fg, c(0xe8e4d8));
        assert_eq!(dark.muted, c(0x8a8474));
        assert_eq!(dark.line, c(0x2a2620));
        assert_eq!(dark.accent, c(0xe8a838));
        assert_eq!(dark.success, c(0x7a9a5a));
        assert_eq!(dark.danger, c(0xc6553e));
        assert_eq!(dark.warning, c(0xe8a838));

        let sepia = Theme::Sepia.tokens();
        assert_eq!(sepia.bg, c(0xf2ede0));
        assert_eq!(sepia.surface, c(0xe8e1d0));
        assert_eq!(sepia.elevated, c(0xddd4be));
        assert_eq!(sepia.fg, c(0x2a3328));
        assert_eq!(sepia.muted, c(0x6a7560));
        assert_eq!(sepia.line, c(0xc9c0a8));
        assert_eq!(sepia.accent, c(0x4a7a3a));
        assert_eq!(sepia.success, c(0x4a7a3a));
        assert_eq!(sepia.danger, c(0xa04030));
        assert_eq!(sepia.warning, c(0x8a6a1a));
    }

    #[test]
    fn foreground_reads_on_background_in_both_themes() {
        for theme in [Theme::Dark, Theme::Sepia] {
            let t = theme.tokens();
            let ratio = contrast(t.fg, t.bg);
            assert!(
                ratio >= 7.0,
                "{theme:?} fg/bg contrast {ratio:.2} < 7.0 (AAA body text)"
            );
        }
    }

    #[test]
    fn semantic_colors_stay_tellable_apart() {
        // Dark: all three semantic colors pairwise distinct.
        let dark = Theme::Dark.tokens();
        assert_ne!(dark.accent, dark.success);
        assert_ne!(dark.accent, dark.danger);
        assert_ne!(dark.success, dark.danger);

        // Sepia: the web pins accent == success (the phosphor green plays
        // both roles) — assert the deliberate pin so an accidental hex
        // edit fails here, and require danger to differ from both.
        let sepia = Theme::Sepia.tokens();
        assert_eq!(sepia.accent, sepia.success);
        assert_ne!(sepia.accent, sepia.danger);
        assert_ne!(sepia.success, sepia.danger);
    }

    #[test]
    fn font_definitions_install_the_machine_and_story_faces() {
        let fonts = font_definitions();

        for cut in [
            CUT_JETBRAINS_REGULAR,
            CUT_JETBRAINS_BOLD,
            CUT_XCHARTER_REGULAR,
            CUT_XCHARTER_BOLD,
        ] {
            let data = fonts
                .font_data
                .get(cut)
                .unwrap_or_else(|| panic!("{cut} not registered"));
            assert!(!data.font.is_empty(), "{cut} embedded empty");
            assert!(
                data.variation_axes().is_empty(),
                "{cut} is variable — egui 0.35 can't select its bold instance; \
                 static cuts only (see the module provenance note)"
            );
        }

        let family = |f: egui::FontFamily| fonts.families.get(&f).cloned().unwrap_or_default();

        // Proportional = Monospace = the machine face, with the builtin
        // fallbacks kept behind the primary.
        for f in [egui::FontFamily::Proportional, egui::FontFamily::Monospace] {
            let list = family(f.clone());
            assert_eq!(
                list.first().map(String::as_str),
                Some(CUT_JETBRAINS_REGULAR)
            );
            assert!(
                list.len() > 1,
                "{f}: builtin glyph fallbacks dropped — ❯/▊/◐ would tofu"
            );
        }

        // The story face (regular + bold) and the machine bold cut each
        // head their own family, with fallbacks behind them.
        for (f, cut) in [
            (story_family(), CUT_XCHARTER_REGULAR),
            (story_bold_family(), CUT_XCHARTER_BOLD),
            (machine_bold_family(), CUT_JETBRAINS_BOLD),
        ] {
            let list = family(f.clone());
            assert_eq!(list.first().map(String::as_str), Some(cut));
            assert!(list.len() > 1, "{f}: builtin glyph fallbacks dropped");
        }
    }

    #[test]
    fn visuals_derive_from_tokens_in_both_themes() {
        for theme in [Theme::Dark, Theme::Sepia] {
            let t = theme.tokens();
            let v = visuals(theme);

            assert_eq!(v.dark_mode, theme.is_dark());
            assert_eq!(v.panel_fill, t.bg);
            assert_eq!(v.window_fill, t.bg);
            assert_eq!(v.extreme_bg_color, t.surface);
            assert_eq!(v.code_bg_color, t.surface);
            assert_eq!(v.hyperlink_color, t.accent);
            assert_eq!(v.error_fg_color, t.danger);
            assert_eq!(v.warn_fg_color, t.warning);
            assert_eq!(v.selection.bg_fill, t.accent);

            // Text color rides the noninteractive widget stroke (egui's
            // default text path).
            assert_eq!(v.widgets.noninteractive.fg_stroke.color, t.fg);

            // Hairline outlines on passive chrome, phosphor outlines on
            // interactive states; 3–4 px rounding everywhere.
            for (name, w, stroke) in [
                ("noninteractive", &v.widgets.noninteractive, t.line),
                ("inactive", &v.widgets.inactive, t.line),
                ("hovered", &v.widgets.hovered, t.accent),
                ("active", &v.widgets.active, t.accent),
                ("open", &v.widgets.open, t.accent),
            ] {
                assert_eq!(w.bg_stroke.color, stroke, "{theme:?} {name} stroke");
                assert!(
                    (3..=4).contains(&w.corner_radius.nw) && w.corner_radius.is_same(),
                    "{theme:?} {name} rounding {} outside 3–4 px",
                    w.corner_radius.nw
                );
            }
        }
    }

    #[test]
    fn style_carries_the_spec_type_scale() {
        use egui::TextStyle;
        let style = style(Theme::Dark);
        let size = |ts: TextStyle| {
            style
                .text_styles
                .get(&ts)
                .unwrap_or_else(|| panic!("{ts:?} missing"))
                .size
        };
        assert_eq!(size(TextStyle::Body), 14.0);
        assert_eq!(size(TextStyle::Button), 14.0);
        assert_eq!(size(TextStyle::Small), 12.5);
        assert_eq!(size(TextStyle::Monospace), 14.0);
        assert_eq!(size(TextStyle::Heading), 18.0);
    }

    #[test]
    fn theme_round_trips_through_the_persisted_name() {
        for theme in [Theme::Dark, Theme::Sepia] {
            let name = theme.persist_name();
            assert_eq!(Theme::from_persisted(Some(name)), theme);
        }
    }

    #[test]
    fn registered_cuts_parse_and_families_shape_text() {
        // epaint panics on any registered font that fails to parse
        // (FontsImpl::new), so touching the font store after `apply`
        // proves all four embedded cuts rasterize — including the CFF
        // XCharter .otf pair, which no stock-egui path exercises.
        let ctx = egui::Context::default();
        apply(&ctx, Theme::Dark);
        // The font store builds on the first pass; drive an empty one.
        let _ = ctx.run_ui(egui::RawInput::default(), |_| {});
        ctx.fonts_mut(|fonts| {
            for family in [
                egui::FontFamily::Proportional,
                egui::FontFamily::Monospace,
                story_family(),
                story_bold_family(),
                machine_bold_family(),
            ] {
                let id = egui::FontId::new(18.0, family.clone());
                assert!(fonts.glyph_width(&id, 'F') > 0.0, "{family} shaped nothing");
            }
        });
    }

    #[test]
    fn absent_or_unrecognized_persisted_values_resolve_dark() {
        assert_eq!(Theme::from_persisted(None), Theme::Dark);
        assert_eq!(Theme::from_persisted(Some("sepia-tomorrow")), Theme::Dark);
        assert_eq!(Theme::from_persisted(Some("")), Theme::Dark);
        assert_eq!(Theme::default(), Theme::Dark);
    }
}
