//! M4 structural cleaning — a port of the reader's
//! `web/src/lib/clean/filters.ts`.
//!
//! Cross-app invariant: parse output is canonical clean text. The web reader
//! re-derives cleaning on every playback (`cleanChapters`), so whatever the
//! reader's filters do to these paragraphs must leave them unchanged —
//! otherwise the reader's text no longer matches the cache key the audio was
//! synthesized under and playback dies on a cache miss (G22). Two rules keep
//! that contract: the filters below stay byte-faithful to their TS originals
//! (same patterns, same application order), and [`clean_book`] is idempotent
//! — `clean_book(parse(x)) == parse(x)` is pinned by test.
//!
//! Pronunciation is deliberately not ported: it stays reader-side
//! (user-configurable), per the kernel-parse spec.

use crate::{ParsedBook, ParsedChapter};
use regex::Regex;
use std::sync::LazyLock;

/// Markdown link whose target is an http(s)/www URL (web `stripUrls`
/// step 1): `[text](url)` keeps `text`.
static MARKDOWN_LINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\[([^\]]*)\]\((?:https?://|www\.)[^\s)]+\)").unwrap());
/// Bare URL (web `stripUrls` step 2): `http(s)://…` or `www.…` to the next
/// whitespace.
static BARE_URL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(?:https?://|www\.)\S+").unwrap());
/// Markdown image (web `stripImages` step 1): `![alt](url)` dropped whole.
static MARKDOWN_IMAGE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)!\[([^\]]*)\]\([^)]+\)").unwrap());
/// Bracketed image/figure marker (web `stripImages` step 2).
static BRACKET_IMAGE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\[(?:image|figure):[^\]]*\]").unwrap());
/// Footnote reference or definition prefix (web `stripFootnoteRefs`
/// step 1): `[n]` / `[n]:`.
static FOOTNOTE_REF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[[0-9]{1,3}\]:?").unwrap());
/// Superscript digits, Latin-1 and modifier-letter forms (web
/// `stripFootnoteRefs` step 2).
static SUPERSCRIPT_DIGITS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\u{b9}\u{b2}\u{b3}\u{2070}-\u{2079}]+").unwrap());
/// Whitespace run left behind by a removal (every web filter's tail).
static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s{2,}").unwrap());
/// A paragraph that is nothing but a page number.
static PAGE_NUMBER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^\s*[0-9]{1,4}\s*$|^\s*page\s+[0-9]+\s*$").unwrap());

/// Collapse whitespace runs (≥ 2 chars) to single spaces and trim — the
/// shared tail of every web filter.
fn collapse(text: &str) -> String {
    SPACES.replace_all(text, " ").trim().to_owned()
}

/// Strip bare URLs and reduce markdown links to their text: `[t](url)`
/// becomes `t`, anything starting `http(s)://` or `www.` is dropped.
fn strip_urls(text: &str) -> String {
    let linked = MARKDOWN_LINK.replace_all(text, "$1");
    let bare = BARE_URL.replace_all(&linked, "");
    collapse(&bare)
}

/// Drop markdown images `![alt](url)` and bracketed `[Image: …]` /
/// `[Figure: …]` markers entirely.
fn strip_images(text: &str) -> String {
    let unimaged = MARKDOWN_IMAGE.replace_all(text, "");
    let unmarked = BRACKET_IMAGE.replace_all(&unimaged, "");
    collapse(&unmarked)
}

/// Drop footnote references: inline `[n]`, definition prefixes `[n]:`, and
/// superscript digits. Parenthesized years (`(1984)`) and large bracketed
/// numbers (`[1234]`) are left alone.
fn strip_footnote_refs(text: &str) -> String {
    let unrefed = FOOTNOTE_REF.replace_all(text, "");
    let desuped = SUPERSCRIPT_DIGITS.replace_all(&unrefed, "");
    collapse(&desuped)
}

/// Whether a paragraph is nothing but a page number: a bare 1–4 digit
/// number, or `page N` in any case.
fn is_page_number_line(text: &str) -> bool {
    PAGE_NUMBER.is_match(text)
}

/// Clean one paragraph's text with every M4 filter, in the reader's order
/// (images → urls → footnotes — the parse seam has no per-filter config).
fn clean_paragraph(text: &str) -> String {
    strip_footnote_refs(&strip_urls(&strip_images(text)))
}

/// Clean every chapter's paragraphs: drop page-number paragraphs, apply the
/// M4 text filters, drop paragraphs emptied by cleaning.
///
/// The page-number check runs both before and after text cleaning: a
/// paragraph like `42 https://x.io` cleans to a bare page number the reader
/// would drop on its own pass, so parse must drop it first to keep its
/// output stable under the reader. Chapter titles pass through untouched,
/// mirroring the reader's `cleanChapters`.
#[must_use]
pub fn clean_book(book: &ParsedBook) -> ParsedBook {
    ParsedBook {
        title: book.title.clone(),
        author: book.author.clone(),
        source_format: book.source_format,
        chapters: book
            .chapters
            .iter()
            .map(|chapter| ParsedChapter {
                title: chapter.title.clone(),
                paragraphs: chapter
                    .paragraphs
                    .iter()
                    .filter(|paragraph| !is_page_number_line(paragraph))
                    .map(|paragraph| clean_paragraph(paragraph))
                    .filter(|paragraph| !is_page_number_line(paragraph))
                    .filter(|paragraph| !paragraph.is_empty())
                    .collect(),
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_urls_drops_bare_http_https_and_www() {
        assert_eq!(strip_urls("see https://example.com/x now"), "see now");
        assert_eq!(strip_urls("visit http://foo.io/a/b"), "visit");
        assert_eq!(strip_urls("go www.example.com here"), "go here");
    }

    #[test]
    fn strip_urls_keeps_markdown_link_text() {
        assert_eq!(strip_urls("[click here](http://x.io/y)"), "click here");
        assert_eq!(strip_urls("[docs](www.example.com)"), "docs");
    }

    #[test]
    fn strip_urls_leaves_non_url_brackets_alone() {
        assert_eq!(
            strip_urls("[see chapter 5](not-a-url)"),
            "[see chapter 5](not-a-url)"
        );
    }

    #[test]
    fn strip_urls_handles_multiple_urls_and_collapses_spaces() {
        assert_eq!(strip_urls("a https://x.io and http://y.io"), "a and");
        assert_eq!(strip_urls("before https://x.io  after"), "before after");
    }

    #[test]
    fn strip_images_drops_markdown_and_bracket_markers() {
        assert_eq!(
            strip_images("text ![a diagram](http://x.io/x.png) tail"),
            "text tail"
        );
        assert_eq!(strip_images("see [Image: figure 1] here"), "see here");
        assert_eq!(strip_images("see [FIGURE: 2] here"), "see here");
    }

    #[test]
    fn strip_images_leaves_ordinary_brackets_alone() {
        assert_eq!(strip_images("[a note] in text"), "[a note] in text");
    }

    #[test]
    fn strip_footnote_refs_drops_inline_defs_and_superscripts() {
        assert_eq!(
            strip_footnote_refs("a claim[1] was made"),
            "a claim was made"
        );
        assert_eq!(strip_footnote_refs("see[42] below"), "see below");
        assert_eq!(strip_footnote_refs("[1]: some note text"), "some note text");
        assert_eq!(
            strip_footnote_refs("mass\u{b2} is energy"),
            "mass is energy"
        );
    }

    #[test]
    fn strip_footnote_refs_keeps_years_and_large_bracketed_numbers() {
        assert_eq!(
            strip_footnote_refs("published (1984) later"),
            "published (1984) later"
        );
        assert_eq!(strip_footnote_refs("ref[1234] here"), "ref[1234] here");
    }

    #[test]
    fn page_number_lines() {
        for line in ["42", "  7  ", "page 12", "Page 99"] {
            assert!(
                is_page_number_line(line),
                "{line:?} should be a page number"
            );
        }
        for line in ["Chapter 42", "42 men arrived", "12345"] {
            assert!(
                !is_page_number_line(line),
                "{line:?} should not be a page number"
            );
        }
    }

    #[test]
    fn clean_paragraph_applies_all_filters_in_reader_order() {
        assert_eq!(
            clean_paragraph("see [1] and https://x.io plus ![img](http://y.io/z.png) end"),
            "see and plus end"
        );
    }

    #[test]
    fn clean_book_drops_page_numbers_empties_and_post_clean_numbers() {
        let book = ParsedBook {
            title: "t".to_owned(),
            author: None,
            source_format: crate::SourceFormat::Txt,
            chapters: vec![ParsedChapter {
                title: "c".to_owned(),
                paragraphs: vec![
                    "12".to_owned(),
                    "![only an image](http://x.io/a.png)".to_owned(),
                    "42 https://x.io".to_owned(),
                    "kept[1]".to_owned(),
                ],
            }],
        };
        let cleaned = clean_book(&book);
        assert_eq!(cleaned.chapters[0].paragraphs, ["kept"]);
        assert_eq!(clean_book(&cleaned), cleaned);
        assert_eq!(book.chapters[0].paragraphs.len(), 4);
    }
}
