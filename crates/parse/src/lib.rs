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

mod detect;
mod txt;

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

/// Failures that can occur while parsing a source document.
#[derive(Debug, thiserror::Error)]
pub enum ParseError {
    /// The format has no parser yet (parsers land one task at a time).
    #[error("no parser implemented for this source format yet")]
    UnsupportedFormat(SourceFormat),
}

/// Parse `bytes` as the given `format` into a [`ParsedBook`].
///
/// `hint` is the source filename, when known; it supplies metadata fallbacks
/// (title from the filename stem). Parsing never fails on encoding — text is
/// decoded lossily — but can fail on structurally invalid containers.
pub fn parse_source(
    bytes: &[u8],
    format: SourceFormat,
    hint: Option<&str>,
) -> Result<ParsedBook, ParseError> {
    match format {
        SourceFormat::Txt => Ok(txt::parse_txt(bytes, hint)),
        other => Err(ParseError::UnsupportedFormat(other)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsupported_formats_error_until_their_parser_lands() {
        for format in [
            SourceFormat::Epub,
            SourceFormat::Html,
            SourceFormat::Md,
            SourceFormat::Docx,
            SourceFormat::Pdf,
        ] {
            let err = parse_source(b"x", format, None).unwrap_err();
            assert!(matches!(err, ParseError::UnsupportedFormat(got) if got == format));
        }
    }
}
