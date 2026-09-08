//! The reader's position backend (task 007): reading positions in
//! egui persisted storage, the [`crate::gui::settings`] pattern — one
//! string key per book (derived core-side by
//! [`taletrek_reader::Position::storage_key`]), one storage entry per
//! field, field-by-field fallback. A corrupt or missing entry means
//! `None` — start of book — never a crash and never a half-position:
//! the position is one fact, so any bad field discards the whole
//! entry rather than resuming somewhere the reader never was.
//!
//! Durability note: writes land in the egui context's persisted map
//! the moment they happen; eframe serializes that map on its
//! autosave interval and again at exit *before* `on_exit` runs — so
//! an advance-time save is on disk by the close, and there is
//! deliberately no exit hook (it would run after the final flush).
//! The save *cadence* is the reader view's: paragraph advance and
//! leaving the reader (`view.rs`), never per-frame.

use eframe::egui;

use taletrek_reader::Position;

/// The chapter field's storage key.
fn chapter_key(book_id: &str) -> String {
    format!("{}.chapter", Position::storage_key(book_id))
}

/// The paragraph-index field's storage key.
fn index_key(book_id: &str) -> String {
    format!("{}.index", Position::storage_key(book_id))
}

/// The offset field's storage key.
fn offset_key(book_id: &str) -> String {
    format!("{}.offset", Position::storage_key(book_id))
}

/// Persist `pos` under the book's storage slot (three field entries;
/// the encoding round-trips through [`load`]).
pub(crate) fn save(ctx: &egui::Context, book_id: &str, pos: Position) {
    ctx.data_mut(|data| {
        data.insert_persisted(egui::Id::new(chapter_key(book_id)), pos.chapter);
        data.insert_persisted(egui::Id::new(index_key(book_id)), pos.index);
        data.insert_persisted(egui::Id::new(offset_key(book_id)), pos.offset);
    });
}

/// The book's saved position — `None` when nothing was saved or any
/// field is corrupt (absent, wrong-typed, or an out-of-domain offset):
/// the caller starts at the top of the book.
pub(crate) fn load(ctx: &egui::Context, book_id: &str) -> Option<Position> {
    ctx.data_mut(|data| {
        let chapter: u32 = data.get_persisted(egui::Id::new(chapter_key(book_id)))?;
        let index: u32 = data.get_persisted(egui::Id::new(index_key(book_id)))?;
        let offset: f64 = data.get_persisted(egui::Id::new(offset_key(book_id)))?;
        (offset.is_finite() && offset >= 0.0).then_some(Position::new(chapter, index, offset))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_then_load_round_trips_per_book() {
        let ctx = egui::Context::default();
        let pos = Position::new(3, 7, 128.5);
        save(&ctx, "bk_test", pos);

        assert_eq!(load(&ctx, "bk_test"), Some(pos));
    }

    #[test]
    fn a_book_with_nothing_saved_loads_none() {
        let ctx = egui::Context::default();
        assert_eq!(load(&ctx, "bk_fresh"), None);
    }

    #[test]
    fn a_corrupt_field_discards_the_whole_entry() {
        // Every corruption shape must mean start-of-book — wrong-typed
        // chapter, missing index, non-finite and negative offsets.
        let ctx = egui::Context::default();
        ctx.data_mut(|data| {
            data.insert_persisted(
                egui::Id::new(chapter_key("bk_test")),
                String::from("not a number"),
            );
        });
        assert_eq!(load(&ctx, "bk_test"), None, "wrong-typed chapter");

        let ctx = egui::Context::default();
        save(&ctx, "bk_test", Position::new(1, 0, 0.0));
        ctx.data_mut(|data| {
            data.remove::<u32>(egui::Id::new(index_key("bk_test")));
        });
        assert_eq!(load(&ctx, "bk_test"), None, "missing index");

        for (name, bad) in [("NaN offset", f64::NAN), ("negative offset", -4.5)] {
            let ctx = egui::Context::default();
            save(&ctx, "bk_test", Position::new(1, 0, 0.0));
            ctx.data_mut(|data| {
                data.insert_persisted(egui::Id::new(offset_key("bk_test")), bad);
            });
            assert_eq!(load(&ctx, "bk_test"), None, "corruption shape: {name}");
        }
    }

    #[test]
    fn books_hold_independent_positions() {
        let ctx = egui::Context::default();
        let a = Position::new(0, 0, 0.0);
        let b = Position::new(5, 2, 63.0);
        save(&ctx, "bk_a", a);
        save(&ctx, "bk_b", b);

        assert_eq!(load(&ctx, "bk_a"), Some(a));
        assert_eq!(load(&ctx, "bk_b"), Some(b));

        // Overwriting one leaves the other's slot untouched.
        let a2 = Position::new(9, 9, 1.5);
        save(&ctx, "bk_a", a2);
        assert_eq!(load(&ctx, "bk_a"), Some(a2));
        assert_eq!(load(&ctx, "bk_b"), Some(b));
    }
}
