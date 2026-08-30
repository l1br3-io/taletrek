//! Plain-text parsing: lossy decode, blank-line paragraph split, one chapter.
//!
//! A paragraph is a run of consecutive non-blank lines joined by single
//! spaces; blank lines separate paragraphs. Chapter detection (standalone
//! `CHAPTER 7`-style lines) is a later task — plain TXT always parses to a
//! single chapter titled from the filename hint's stem.

use crate::{ParsedBook, ParsedChapter, SourceFormat};

/// Fallback title when no filename hint (or an empty stem) is available.
const UNTITLED: &str = "Untitled";

/// Parse plain-text `bytes` into a single-chapter [`ParsedBook`].
///
/// The text is decoded lossily (invalid UTF-8 becomes replacement
/// characters), so encoding can never fail a parse. `hint` is the source
/// filename, when known; its stem becomes the book and chapter title.
pub fn parse_txt(bytes: &[u8], hint: Option<&str>) -> ParsedBook {
    let title = hint
        .and_then(filename_stem)
        .unwrap_or_else(|| UNTITLED.to_owned());
    let text = String::from_utf8_lossy(bytes);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    ParsedBook {
        title: title.clone(),
        author: None,
        source_format: SourceFormat::Txt,
        chapters: vec![ParsedChapter {
            title,
            paragraphs: split_paragraphs(text),
        }],
    }
}

/// Split text into paragraphs on blank lines: consecutive non-blank lines
/// join (single space) into one paragraph.
fn split_paragraphs(text: &str) -> Vec<String> {
    let mut paragraphs = Vec::new();
    let mut current: Vec<&str> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            if !current.is_empty() {
                paragraphs.push(current.join(" "));
                current.clear();
            }
        } else {
            current.push(line);
        }
    }
    if !current.is_empty() {
        paragraphs.push(current.join(" "));
    }
    paragraphs
}

/// Derive a filename stem from a hint, path-free: the final path component
/// without its extension. A leading-dot name (`.hidden`) keeps its dot.
fn filename_stem(hint: &str) -> Option<String> {
    let name = hint.rsplit(['/', '\\']).next()?;
    let stem = match name.rfind('.') {
        Some(at) if at > 0 => &name[..at],
        _ => name,
    };
    (!stem.is_empty()).then(|| stem.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_paragraphs_on_blank_lines() {
        let book = parse_txt(b"one two\r\nthree\n\nfour", None);
        assert_eq!(book.chapters[0].paragraphs, ["one two three", "four"]);
    }

    #[test]
    fn joined_lines_collapse_to_single_spaces() {
        let book = parse_txt(b"alpha\nbeta", None);
        assert_eq!(book.chapters[0].paragraphs, ["alpha beta"]);
    }

    #[test]
    fn lossy_utf8_never_fails() {
        let book = parse_txt(&[0xff, 0xfe, b' ', b'a'], None);
        assert_eq!(book.chapters[0].paragraphs, ["\u{fffd}\u{fffd} a"]);
    }

    #[test]
    fn strips_leading_bom() {
        let book = parse_txt("\u{feff}hello\n\nworld".as_bytes(), None);
        assert_eq!(book.chapters[0].paragraphs, ["hello", "world"]);
    }

    #[test]
    fn single_chapter_titled_from_hint_stem() {
        let book = parse_txt(b"body", Some("book.txt"));
        assert_eq!(book.title, "book");
        assert_eq!(book.chapters.len(), 1);
        assert_eq!(book.chapters[0].title, "book");
    }

    #[test]
    fn title_takes_final_path_component() {
        assert_eq!(parse_txt(b"x", Some("books/my book.txt")).title, "my book");
        assert_eq!(parse_txt(b"x", Some("noext")).title, "noext");
        assert_eq!(parse_txt(b"x", Some(".hidden")).title, ".hidden");
    }

    #[test]
    fn title_fallback_untitled() {
        assert_eq!(parse_txt(b"x", None).title, UNTITLED);
        assert_eq!(parse_txt(b"x", Some("dir/")).title, UNTITLED);
        assert_eq!(parse_txt(b"x", Some("book.")).title, "book");
    }
}
