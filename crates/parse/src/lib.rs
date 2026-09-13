//! TaleTrek parsing core — bytes in, [`ParsedBook`] out.
//!
//! This crate is the kernel's ingestion front door: it turns raw ebook and
//! document bytes (EPUB, TXT, HTML, Markdown, DOCX, PDF) into plain,
//! format-independent data that downstream consumers (the desktop CLI today;
//! the GUI and mobile apps via UniFFI later) wrap into a text-only bundle.
//!
//! The API is deliberately pure — `&[u8]`/`&str` in, plain data out — so
//! parsing never touches the filesystem, clock, or randomness; ids and
//! timestamps are born only at bundle-build time. Text is decoded lossily
//! (invalid UTF-8 becomes replacement characters), so encoding can never
//! fail a parse; only structurally invalid containers can.
//!
//! Format detection ([`detect_format`]) is content-based where a magic
//! signature exists (PDF, EPUB, DOCX). TXT, Markdown, and HTML carry no
//! magic bytes and are extension-mapped by the caller instead.
//!
//! The interchange hop lives here too: [`to_text_only_bundle`] wraps a
//! [`ParsedBook`] into a v1 text-only `.taletrek` bundle, stamping fresh
//! ids and now-ms timestamps — the one place this crate touches
//! randomness or the clock.

mod bundle;
mod clean;
mod detect;
mod docx;
mod epub;
mod html;
mod md;
mod pdf;
mod txt;

pub use bundle::{deterministic_book_id, to_text_only_bundle, to_text_only_bundle_with_id};
pub use clean::clean_book;
pub use detect::detect_format;

use serde::{Deserialize, Serialize};

/// The source document formats the kernel can parse.
///
/// The serde serialization is the lowercase manifest vocabulary
/// (`epub`/`txt`/`html`/`md`/`docx`/`pdf`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceFormat {
    /// EPUB (OCF zip container + OPF package).
    Epub,
    /// Plain text.
    Txt,
    /// HTML document.
    Html,
    /// Markdown document.
    Md,
    /// Office Open XML word-processing document (DOCX).
    Docx,
    /// PDF document.
    Pdf,
}

/// A parsed document: format-independent plain data, UniFFI-ready.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ParsedBook {
    /// Book title, from document metadata or the filename-stem fallback.
    pub title: String,
    /// Author, when the source format carries one.
    pub author: Option<String>,
    /// The format the bytes were parsed as.
    pub source_format: SourceFormat,
    /// Chapters in reading order; always at least one.
    pub chapters: Vec<ParsedChapter>,
}

/// One chapter of a [`ParsedBook`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ParsedChapter {
    /// Chapter title.
    pub title: String,
    /// Chapter body as paragraphs of canonical text.
    pub paragraphs: Vec<String>,
}

impl std::fmt::Display for SourceFormat {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            SourceFormat::Epub => "epub",
            SourceFormat::Txt => "txt",
            SourceFormat::Html => "html",
            SourceFormat::Md => "md",
            SourceFormat::Docx => "docx",
            SourceFormat::Pdf => "pdf",
        })
    }
}

/// Failures that can occur while parsing a source document.
#[derive(Debug, thiserror::Error)]
pub enum ParseError {
    /// The format has no parser. No [`SourceFormat`] variant hits this
    /// today (all six parse); the variant stays in the public API so a
    /// future format can land without breaking it.
    #[error("no parser implemented for this source format yet")]
    UnsupportedFormat(SourceFormat),
    /// The container is structurally invalid — a corrupt zip, a missing
    /// package document — so parsing cannot proceed. The
    /// encoding-never-fails rule only covers text; containers can fail.
    #[error("malformed {format} source: {detail}")]
    Malformed {
        /// The format whose container was invalid.
        format: SourceFormat,
        /// What exactly is wrong.
        detail: String,
    },
}

/// Fallback title (crate-shared) when neither the document nor the filename
/// hint supplies one.
pub(crate) const UNTITLED: &str = "Untitled";

/// Derive a filename stem from a hint, path-free: the final path component
/// without its extension. A leading-dot name (`.hidden`) keeps its dot.
pub(crate) fn filename_stem(hint: &str) -> Option<String> {
    let name = hint.rsplit(['/', '\\']).next()?;
    let stem = match name.rfind('.') {
        Some(at) if at > 0 => &name[..at],
        _ => name,
    };
    (!stem.is_empty()).then(|| stem.to_owned())
}

/// Collapse whitespace runs to single spaces and trim — the shape every
/// paragraph and heading text takes.
pub(crate) fn normalize(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Append `text` to the running chapter, opening a fallback-titled chapter
/// for content that precedes the first split heading — the TXT/MD/HTML
/// parsers' shared leading-content pattern.
pub(crate) fn push_paragraph(
    chapters: &mut Vec<ParsedChapter>,
    fallback_title: &str,
    text: String,
) {
    if chapters.is_empty() {
        chapters.push(ParsedChapter {
            title: fallback_title.to_owned(),
            paragraphs: Vec::new(),
        });
    }
    chapters
        .last_mut()
        .expect("just ensured non-empty")
        .paragraphs
        .push(text);
}

/// Parse `bytes` as the given `format` into a [`ParsedBook`].
///
/// `hint` is the source filename, when known; it supplies metadata fallbacks
/// (title from the filename stem). Parsing never fails on encoding — text is
/// decoded lossily — but can fail on structurally invalid containers.
///
/// Paragraphs come out as canonical clean text: the M4 structural filters
/// ([`clean_book`]) run here, in `parse_source` itself, so every format gets
/// identical cleaning through a single seam.
pub fn parse_source(
    bytes: &[u8],
    format: SourceFormat,
    hint: Option<&str>,
) -> Result<ParsedBook, ParseError> {
    let parsed = match format {
        SourceFormat::Txt => txt::parse_txt(bytes, hint),
        SourceFormat::Md => md::parse_md(bytes, hint),
        SourceFormat::Html => html::parse_html(bytes, hint),
        SourceFormat::Epub => return epub::parse_epub(bytes, hint).map(|book| clean_book(&book)),
        SourceFormat::Docx => return docx::parse_docx(bytes, hint).map(|book| clean_book(&book)),
        SourceFormat::Pdf => return pdf::parse_pdf(bytes, hint).map(|book| clean_book(&book)),
    };
    Ok(clean_book(&parsed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_source_strips_structural_noise() {
        let book = parse_source(
            b"see https://x.io and [1] plus ![img](http://y.io/z.png) end",
            SourceFormat::Txt,
            None,
        )
        .expect("txt parses");
        assert_eq!(book.chapters[0].paragraphs, ["see and plus end"]);
    }

    #[test]
    fn parse_source_drops_page_number_paragraphs() {
        let book =
            parse_source(b"7\n\nkept\n\npage 12", SourceFormat::Txt, None).expect("txt parses");
        assert_eq!(book.chapters[0].paragraphs, ["kept"]);
    }

    #[test]
    fn parse_source_drops_paragraphs_emptied_by_cleaning() {
        let book = parse_source(
            b"![cover](http://y.io/c.png)\n\nkept",
            SourceFormat::Txt,
            None,
        )
        .expect("txt parses");
        assert_eq!(book.chapters[0].paragraphs, ["kept"]);
    }

    #[test]
    fn parse_source_drops_paragraphs_cleaned_to_bare_page_numbers() {
        let book = parse_source(b"42 https://x.io", SourceFormat::Txt, None).expect("txt parses");
        assert!(book.chapters[0].paragraphs.is_empty());
    }
}
