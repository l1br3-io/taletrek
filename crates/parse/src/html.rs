//! HTML parsing: `scraper` (html5ever) tree walk → blocks → chapters.
//!
//! Single-file HTML is structural: `h1` starts and titles a chapter — when
//! the document carries no `h1`, `h2` steps in (realistic articles often
//! title the page only in `<title>`) — while deeper headings and the walked
//! block elements (`p`, `blockquote`, `li`, `pre`) join the running chapter
//! as paragraphs. Extraction is safe by construction: only `body` is
//! walked, only block elements emit text, and the chrome elements
//! (`script`/`style`/`nav`/`aside`/`header`/`footer`) are never entered —
//! nothing is filtered out after the fact. Inline links keep their text
//! (an `href` is an attribute, not text); images drop outright, with no
//! alt-text rescue. Book title = `<title>` text, then the filename-hint
//! stem.
//!
//! [`extract_blocks`] is the content-extraction core the EPUB parser
//! reuses: a pure string → blocks seam with no file or URL assumptions;
//! full documents and bare fragments both work (html5ever synthesizes the
//! missing structure).

use crate::filename_stem;
use crate::{normalize, push_paragraph, ParsedBook, ParsedChapter, SourceFormat, UNTITLED};
use scraper::{ElementRef, Html, Node, Selector};
use std::sync::LazyLock;

/// The body element of a parsed document.
static BODY_SELECTOR: LazyLock<Selector> =
    LazyLock::new(|| Selector::parse("body").expect("static selector parses"));
/// The document's `<title>` (metadata, not content).
static TITLE_SELECTOR: LazyLock<Selector> =
    LazyLock::new(|| Selector::parse("title").expect("static selector parses"));

/// Site chrome and machinery: never entered by the walk.
const EXCLUDED_ELEMENTS: [&str; 6] = ["script", "style", "nav", "aside", "header", "footer"];
/// Body elements that emit a paragraph each.
const BLOCK_ELEMENTS: [&str; 4] = ["p", "blockquote", "li", "pre"];
/// Elements that contribute a word space at their boundary when joining a
/// block's descendant text — so minified nesting (`<p>a</p><p>b</p>` inside
/// a blockquote) still reads as separate words. Inline elements stay
/// boundary-free.
const SPACING_ELEMENTS: [&str; 25] = [
    "br",
    "hr",
    "p",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "li",
    "ul",
    "ol",
    "dl",
    "dt",
    "dd",
    "blockquote",
    "pre",
    "div",
    "table",
    "thead",
    "tbody",
    "tr",
    "figure",
    "figcaption",
    "section",
];

/// One structural block of extracted content — the shared currency between
/// this module (single-file HTML) and the EPUB parser's chapter bodies.
#[derive(Debug, Clone, PartialEq)]
pub enum Block {
    /// An `h1`–`h6` heading: its level and normalized text.
    Heading(u8, String),
    /// A body paragraph (`p`, `blockquote`, `li`, `pre`): normalized text.
    Paragraph(String),
}

/// Extract the content blocks of an HTML document or fragment.
///
/// The input is any HTML string — a full document, a body fragment, or an
/// EPUB chapter body; html5ever supplies whatever structure is missing.
/// Only `body` is walked, in document order, and only block elements emit
/// blocks: chrome (`script`/`style`/`nav`/`aside`/`header`/`footer`) never
/// enters by construction, and bare text between block elements is not
/// content. Empty blocks (whitespace-only, image-only) are dropped here.
pub fn extract_blocks(html: &str) -> Vec<Block> {
    let document = Html::parse_document(html);
    blocks_of(&document)
}

/// Blocks of a parsed document — [`extract_blocks`] minus the parse.
fn blocks_of(document: &Html) -> Vec<Block> {
    let mut blocks = Vec::new();
    if let Some(body) = document.select(&BODY_SELECTOR).next() {
        walk(body, &mut blocks);
    }
    blocks
}

/// Depth-first walk in document order: excluded elements are skipped with
/// their whole subtree, block elements emit one block and are not descended
/// into (their text is captured whole), everything else is a container to
/// walk through.
fn walk(element: ElementRef, blocks: &mut Vec<Block>) {
    let name = element.value().name();
    if EXCLUDED_ELEMENTS.contains(&name) {
        return;
    }
    if let Some(level) = heading_level(name) {
        let text = element_text(&element);
        if !text.is_empty() {
            blocks.push(Block::Heading(level, text));
        }
    } else if BLOCK_ELEMENTS.contains(&name) {
        let text = element_text(&element);
        if !text.is_empty() {
            blocks.push(Block::Paragraph(text));
        }
    } else {
        for child in element.child_elements() {
            walk(child, blocks);
        }
    }
}

/// Heading level of an element name: `h1`–`h6` → `1`–`6`, else `None`.
fn heading_level(name: &str) -> Option<u8> {
    name.strip_prefix('h')?
        .parse::<u8>()
        .ok()
        .filter(|level| (1..=6).contains(level))
}

/// A block element's text: descendant text nodes joined, with a word space
/// at block-element boundaries and at `<br>`, normalized to canonical
/// shape.
fn element_text(element: &ElementRef) -> String {
    let mut text = String::new();
    for descendant in element.descendants() {
        match descendant.value() {
            Node::Text(fragment) => text.push_str(fragment),
            Node::Element(inner) if SPACING_ELEMENTS.contains(&inner.name()) => text.push(' '),
            _ => {}
        }
    }
    normalize(&text)
}

/// Parse HTML `bytes` into a [`ParsedBook`], splitting chapters on
/// level-1 headings (level-2 when no `h1` exists).
///
/// The text is decoded lossily (invalid UTF-8 becomes replacement
/// characters), so encoding can never fail a parse. `hint` is the source
/// filename, when known; its stem backs the book-title and leading-chapter
/// fallbacks behind `<title>`.
pub fn parse_html(bytes: &[u8], hint: Option<&str>) -> ParsedBook {
    let fallback_title = hint
        .and_then(filename_stem)
        .unwrap_or_else(|| UNTITLED.to_owned());
    let text = String::from_utf8_lossy(bytes);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    let document = Html::parse_document(text);
    let blocks = blocks_of(&document);
    ParsedBook {
        title: document_title(&document).unwrap_or_else(|| fallback_title.clone()),
        author: None,
        source_format: SourceFormat::Html,
        chapters: assemble(blocks, &fallback_title),
    }
}

/// The normalized `<title>` text, when the document carries a non-empty
/// one.
fn document_title(document: &Html) -> Option<String> {
    document
        .select(&TITLE_SELECTOR)
        .next()
        .map(|title| normalize(&title.text().collect::<String>()))
        .filter(|title| !title.is_empty())
}

/// Assemble blocks into chapters: headings at the split level start and
/// title chapters, everything else joins the running chapter as a
/// paragraph. The split level is `h1` when any `h1` exists, else `h2` when
/// any `h2` exists, else none — `h3`+ never splits.
fn assemble(blocks: Vec<Block>, fallback_title: &str) -> Vec<ParsedChapter> {
    let has_heading = |level: u8| {
        blocks
            .iter()
            .any(|block| matches!(block, Block::Heading(at, _) if *at == level))
    };
    let split_level = if has_heading(1) {
        Some(1)
    } else if has_heading(2) {
        Some(2)
    } else {
        None
    };
    let mut chapters: Vec<ParsedChapter> = Vec::new();
    for block in blocks {
        match block {
            Block::Heading(level, text) if Some(level) == split_level => {
                chapters.push(ParsedChapter {
                    title: text,
                    paragraphs: Vec::new(),
                });
            }
            Block::Heading(_, text) | Block::Paragraph(text) => {
                push_paragraph(&mut chapters, fallback_title, text);
            }
        }
    }
    if chapters.is_empty() {
        chapters.push(ParsedChapter {
            title: fallback_title.to_owned(),
            paragraphs: Vec::new(),
        });
    }
    chapters
}

#[cfg(test)]
mod tests {
    use super::*;

    fn titles(book: &ParsedBook) -> Vec<&str> {
        book.chapters.iter().map(|c| c.title.as_str()).collect()
    }

    #[test]
    fn level_one_headings_split_and_title_chapters() {
        let book = parse_html(b"<h1>One</h1><p>a</p><h1>Two</h1><p>b</p>", None);
        assert_eq!(titles(&book), ["One", "Two"]);
        assert_eq!(book.chapters[0].paragraphs, ["a"]);
        assert_eq!(book.chapters[1].paragraphs, ["b"]);
        assert_eq!(book.source_format, SourceFormat::Html);
        assert!(book.author.is_none());
    }

    #[test]
    fn h2_splits_only_when_no_h1_exists() {
        let book = parse_html(
            b"<h2>Alpha</h2><p>a</p><h2>Beta</h2><p>b</p>",
            Some("notes.html"),
        );
        assert_eq!(titles(&book), ["Alpha", "Beta"]);
        assert_eq!(book.title, "notes");
        let mixed = parse_html(b"<h1>Real</h1><h2>Sub</h2><p>body</p>", None);
        assert_eq!(titles(&mixed), ["Real"]);
        assert_eq!(mixed.chapters[0].paragraphs, ["Sub", "body"]);
    }

    #[test]
    fn h3_never_splits() {
        let book = parse_html(b"<h3>Only</h3><p>body</p>", None);
        assert_eq!(titles(&book), ["Untitled"]);
        assert_eq!(book.chapters[0].paragraphs, ["Only", "body"]);
    }

    #[test]
    fn chrome_elements_never_enter_by_construction() {
        let blocks = extract_blocks(
            "<div><script>evil()</script><style>.a{color:red}</style>\
             <nav>menu</nav><aside>margin note</aside><header>banner</header>\
             <footer>colophon</footer><p>kept</p></div>",
        );
        assert_eq!(blocks, [Block::Paragraph("kept".to_owned())]);
    }

    #[test]
    fn header_nested_h1_is_not_a_chapter() {
        let book = parse_html(
            b"<header><h1>Site Banner</h1><p>blurb</p></header><h1>Real</h1><p>body</p>",
            None,
        );
        assert_eq!(titles(&book), ["Real"]);
        assert_eq!(book.chapters[0].paragraphs, ["body"]);
    }

    #[test]
    fn links_keep_text_images_drop_alt_and_all() {
        let book = parse_html(
            b"<p>see <a href='https://x.io/log'>the log</a> and <img src='x.png' alt='a picture'> end</p>",
            None,
        );
        assert_eq!(book.chapters[0].paragraphs, ["see the log and end"]);
        let empty = parse_html(b"<p><img src='x.png' alt='only an image'></p>", None);
        assert!(empty.chapters[0].paragraphs.is_empty());
    }

    #[test]
    fn br_becomes_a_space() {
        let book = parse_html(b"<p>line one<br>line two</p>", None);
        assert_eq!(book.chapters[0].paragraphs, ["line one line two"]);
    }

    #[test]
    fn blockquote_joins_nested_paragraphs_with_spaces() {
        let book = parse_html(b"<blockquote><p>a</p><p>b</p></blockquote>", None);
        assert_eq!(book.chapters[0].paragraphs, ["a b"]);
    }

    #[test]
    fn book_title_from_title_element_then_hint_stem_then_untitled() {
        let titled = parse_html(
            b"<html><head><title>  Page   Name </title></head><body><p>x</p></body></html>",
            Some("whatever.html"),
        );
        assert_eq!(titled.title, "Page Name");
        assert_eq!(
            parse_html(b"<p>x</p>", Some("my page.html")).title,
            "my page"
        );
        assert_eq!(parse_html(b"<p>x</p>", None).title, UNTITLED);
    }

    #[test]
    fn no_headings_yields_single_fallback_chapter() {
        let book = parse_html(b"<p>one</p><p>two</p>", Some("book.html"));
        assert_eq!(titles(&book), ["book"]);
        assert_eq!(book.chapters[0].paragraphs, ["one", "two"]);
    }

    #[test]
    fn content_before_first_heading_lands_in_fallback_chapter() {
        let book = parse_html(b"<p>intro</p><h1>One</h1><p>body</p>", Some("book.html"));
        assert_eq!(titles(&book), ["book", "One"]);
        assert_eq!(book.chapters[0].paragraphs, ["intro"]);
        assert_eq!(book.chapters[1].paragraphs, ["body"]);
    }

    #[test]
    fn extract_blocks_accepts_fragments_and_walks_containers() {
        assert_eq!(
            extract_blocks("<p>hi</p>"),
            [Block::Paragraph("hi".to_owned())]
        );
        assert_eq!(
            extract_blocks("<section><div><p>deep</p></div></section>"),
            [Block::Paragraph("deep".to_owned())]
        );
        assert_eq!(
            extract_blocks("<table><tr><td>cell</td><td><p>wrapped</p></td></tr></table>"),
            [Block::Paragraph("wrapped".to_owned())]
        );
    }

    #[test]
    fn bare_body_text_between_blocks_is_not_content() {
        assert_eq!(
            extract_blocks("loose words <p>kept</p> more"),
            [Block::Paragraph("kept".to_owned())]
        );
    }

    #[test]
    fn block_elements_are_not_descended_into() {
        let blocks =
            extract_blocks("<blockquote><p>a</p></blockquote><ul><li>x</li><li>y</li></ul>");
        assert_eq!(
            blocks,
            [
                Block::Paragraph("a".to_owned()),
                Block::Paragraph("x".to_owned()),
                Block::Paragraph("y".to_owned()),
            ]
        );
    }

    #[test]
    fn lossy_utf8_never_fails() {
        let book = parse_html(
            &[b'<', b'p', b'>', 0xff, b' ', b'a', b'<', b'/', b'p', b'>'],
            None,
        );
        assert_eq!(book.chapters[0].paragraphs, ["\u{fffd} a"]);
    }

    #[test]
    fn strips_leading_bom() {
        let book = parse_html("\u{feff}<p>hello</p>".as_bytes(), None);
        assert_eq!(book.chapters[0].paragraphs, ["hello"]);
    }
}
