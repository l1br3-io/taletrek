//! Chapter text model — `text.json` inside a `.taletrek` archive.
//!
//! Mirrors the SPA's `Chapter` type so the SPA can ingest a bundle without
//! translation.

use serde::{Deserialize, Serialize};

/// Wrapper for the `text.json` file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TextFile {
    /// Format schema version.
    pub schema_version: u32,
    /// Chapters in index order.
    pub chapters: Vec<ChapterText>,
}

/// One chapter's cleaned text. Field names match the SPA `Chapter` type
/// (camelCase in JSON).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterText {
    /// Chapter id (`ch_…`).
    pub id: String,
    /// Owning book id (`bk_…`).
    pub book_id: String,
    /// Zero-based chapter index.
    pub index: u32,
    /// Chapter title.
    pub title: String,
    /// Cleaned paragraph strings.
    #[serde(default)]
    pub paragraphs: Vec<String>,
    /// Optional M10 headings.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub headings: Vec<String>,
}

impl ChapterText {
    /// Construct a minimal chapter (helper for tests/fixtures).
    #[must_use]
    pub fn new(book_id: &str, index: u32, title: &str, paragraphs: Vec<String>) -> Self {
        Self {
            id: format!("ch_{book_id}_{index}"),
            book_id: book_id.to_string(),
            index,
            title: title.to_string(),
            paragraphs,
            headings: Vec::new(),
        }
    }
}
