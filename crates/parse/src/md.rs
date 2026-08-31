//! Markdown parsing: `pulldown-cmark` events → chapters by heading level.
//!
//! Level-1 headings (`#`, ATX or setext) start new chapters and title them;
//! deeper headings (`##`+) render as their text line — a standalone paragraph
//! — inside the running chapter. Inline links keep only their text and images
//! are dropped outright, both at event level, before the M4 clean seam runs.
//! Content before the first `#` lands under the fallback title (filename-hint
//! stem), mirroring the TXT chapter split. Book title = the first `#`'s text
//! (already a chapter title); without one, the hint stem — then `Untitled`.
//!
//! Only CommonMark is enabled (no GFM extensions, no smart punctuation): the
//! cross-app invariant is that source text passes through byte-faithfully —
//! em-dashes and curly quotes in the source survive exactly as written, and
//! undefined `[n]` markers stay literal for the clean seam to strip.

use crate::filename_stem;
use crate::{ParsedBook, ParsedChapter, SourceFormat, UNTITLED};
use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd};

/// Parse Markdown `bytes` into a [`ParsedBook`], splitting chapters on
/// level-1 headings.
///
/// The text is decoded lossily (invalid UTF-8 becomes replacement
/// characters), so encoding can never fail a parse. `hint` is the source
/// filename, when known; its stem is the book-title and leading-chapter
/// fallback.
pub fn parse_md(bytes: &[u8], hint: Option<&str>) -> ParsedBook {
    let fallback_title = hint
        .and_then(filename_stem)
        .unwrap_or_else(|| UNTITLED.to_owned());
    let text = String::from_utf8_lossy(bytes);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);

    let mut chapters: Vec<ParsedChapter> = Vec::new();
    let mut book_title: Option<String> = None;
    let mut buffer = String::new();
    let mut image_depth: usize = 0;

    for event in Parser::new_ext(text, Options::empty()) {
        match event {
            Event::Start(Tag::Heading { .. }) => buffer.clear(),
            Event::Start(Tag::Image { .. }) => image_depth += 1,
            Event::End(TagEnd::Image) => image_depth = image_depth.saturating_sub(1),
            Event::Text(text) | Event::Code(text) => {
                if image_depth == 0 {
                    buffer.push_str(&text);
                }
            }
            Event::SoftBreak | Event::HardBreak => {
                if image_depth == 0 {
                    buffer.push(' ');
                }
            }
            Event::End(TagEnd::Heading(level)) => {
                let text = normalize(&buffer);
                buffer.clear();
                if level == HeadingLevel::H1 {
                    if book_title.is_none() {
                        book_title = Some(text.clone());
                    }
                    chapters.push(ParsedChapter {
                        title: text,
                        paragraphs: Vec::new(),
                    });
                } else if !text.is_empty() {
                    push_paragraph(&mut chapters, &fallback_title, text);
                }
            }
            Event::End(TagEnd::Paragraph | TagEnd::Item | TagEnd::CodeBlock) => {
                let text = normalize(&buffer);
                buffer.clear();
                if !text.is_empty() {
                    push_paragraph(&mut chapters, &fallback_title, text);
                }
            }
            Event::Html(_)
            | Event::InlineHtml(_)
            | Event::FootnoteReference(_)
            | Event::Rule
            | Event::TaskListMarker(_)
            | Event::InlineMath(_)
            | Event::DisplayMath(_) => {}
            Event::Start(_) | Event::End(_) => {}
        }
    }

    if chapters.is_empty() {
        chapters.push(ParsedChapter {
            title: fallback_title.clone(),
            paragraphs: Vec::new(),
        });
    }
    ParsedBook {
        title: book_title.unwrap_or(fallback_title),
        author: None,
        source_format: SourceFormat::Md,
        chapters,
    }
}

/// Append `text` to the running chapter, opening a fallback-titled chapter
/// for content that precedes the first level-1 heading.
fn push_paragraph(chapters: &mut Vec<ParsedChapter>, fallback_title: &str, text: String) {
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

/// Collapse whitespace runs to single spaces and trim — the shape every
/// paragraph and heading text takes.
fn normalize(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn level_one_headings_split_and_title_chapters() {
        let book = parse_md(b"# One\n\na\n\n# Two\n\nb", None);
        let titles: Vec<&str> = book.chapters.iter().map(|c| c.title.as_str()).collect();
        assert_eq!(titles, ["One", "Two"]);
        assert_eq!(book.chapters[0].paragraphs, ["a"]);
        assert_eq!(book.chapters[1].paragraphs, ["b"]);
    }

    #[test]
    fn book_title_is_first_level_one_heading() {
        let book = parse_md(b"# Title Here\n\nbody", Some("book.md"));
        assert_eq!(book.title, "Title Here");
        assert_eq!(book.source_format, SourceFormat::Md);
        assert!(book.author.is_none());
    }

    #[test]
    fn no_level_one_title_falls_back_to_hint_stem_then_untitled() {
        assert_eq!(parse_md(b"body", Some("my book.md")).title, "my book");
        assert_eq!(parse_md(b"body", None).title, UNTITLED);
    }

    #[test]
    fn no_headings_yields_single_fallback_chapter() {
        let book = parse_md(b"one\n\ntwo", Some("book.md"));
        assert_eq!(book.chapters.len(), 1);
        assert_eq!(book.chapters[0].title, "book");
        assert_eq!(book.chapters[0].paragraphs, ["one", "two"]);
    }

    #[test]
    fn content_before_first_heading_lands_in_fallback_chapter() {
        let book = parse_md(b"intro\n\n# One\n\nbody", Some("book.md"));
        assert_eq!(book.chapters[0].title, "book");
        assert_eq!(book.chapters[0].paragraphs, ["intro"]);
        assert_eq!(book.chapters[0].paragraphs.len(), 1);
        assert_eq!(book.chapters[1].paragraphs, ["body"]);
    }

    #[test]
    fn deeper_headings_survive_as_text_paragraphs() {
        let book = parse_md(b"# One\n\n## Sub\n\nbody\n\n### Deeper\n\ntail", None);
        assert_eq!(book.chapters.len(), 1);
        assert_eq!(
            book.chapters[0].paragraphs,
            ["Sub", "body", "Deeper", "tail"]
        );
    }

    #[test]
    fn links_reduce_to_text_and_images_drop_at_event_level() {
        let book = parse_md(
            b"see [a link](https://x.io/a) and ![img](https://x.io/b.png) end",
            None,
        );
        assert_eq!(book.chapters[0].paragraphs, ["see a link and end"]);
    }

    #[test]
    fn soft_and_hard_breaks_become_spaces() {
        let book = parse_md(b"alpha\nbeta\n\ngamma  \ndelta", None);
        assert_eq!(book.chapters[0].paragraphs, ["alpha beta", "gamma delta"]);
    }

    #[test]
    fn reference_links_reduce_to_text_and_definitions_vanish() {
        let book = parse_md(
            b"[site][1] is up\n\n[1]: https://example.com/site\n\nplain [2] stays",
            None,
        );
        assert_eq!(
            book.chapters[0].paragraphs,
            ["site is up", "plain [2] stays"]
        );
    }

    #[test]
    fn lossy_utf8_never_fails() {
        let book = parse_md(&[0xff, 0xfe, b' ', b'a'], None);
        assert_eq!(book.chapters[0].paragraphs, ["\u{fffd}\u{fffd} a"]);
    }

    #[test]
    fn strips_leading_bom() {
        let book = parse_md("\u{feff}hello\n\nworld".as_bytes(), None);
        assert_eq!(book.chapters[0].paragraphs, ["hello", "world"]);
    }
}
