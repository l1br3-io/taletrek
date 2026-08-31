//! Golden-fixture tests: committed source files parsed to exact `ParsedBook`s.
//!
//! One committed fixture per format is the primary gate of this crate — no
//! format ships without one. The TXT fixture carries chapter lines plus
//! URL/footnote/image/page-number noise (all consumed by the M4 clean seam);
//! the PDF fixtures come in two shapes — with and without an `/Outlines`
//! tree — pinning ADR-0008's tier-1 outline rule; every other format pins
//! its own structural split.
//!
//! The clean-idempotence contract — parse output must survive [`clean_book`]
//! unchanged, mirroring the reader's `cleanChapters` — is pinned for every
//! parseable fixture below.

use taletrek_parse::{clean_book, parse_source, ParsedBook, ParsedChapter, SourceFormat};

#[test]
fn txt_plain_parses_to_exact_book() {
    let bytes = include_bytes!("../testdata/plain.txt");
    let book = parse_source(bytes, SourceFormat::Txt, Some("plain.txt")).expect("txt parses");
    assert_eq!(
        book,
        ParsedBook {
            title: "plain".to_owned(),
            author: None,
            source_format: SourceFormat::Txt,
            chapters: vec![
                ParsedChapter {
                    title: "Chapter One".to_owned(),
                    paragraphs: vec![
                        "The North Wind and the Sun were disputing which was the stronger, when a traveler came along wrapped in a warm cloak. See for the original telling.".to_owned(),
                        "Aesop, \"The North Wind and the Sun\", fable 46.".to_owned(),
                        "They agreed that the one who first made the traveler take off his cloak should be considered stronger than the other.".to_owned(),
                        "Then the North Wind blew as hard as he could; but the more he blew the more closely did the traveler fold his cloak around him; and at last the North Wind gave up the attempt. Then the Sun shone out warmly, and immediately the traveler took off his cloak.".to_owned(),
                    ],
                },
                ParsedChapter {
                    title: "Chapter Two".to_owned(),
                    paragraphs: vec![
                        "And so the North Wind was obliged to confess that the Sun was stronger of the two, as told by Aesop. They parted as friends after the contest.".to_owned(),
                    ],
                },
            ],
        }
    );
}

#[test]
fn md_parses_to_exact_book() {
    let bytes = include_bytes!("../testdata/book.md");
    let book = parse_source(bytes, SourceFormat::Md, Some("book.md")).expect("md parses");
    assert_eq!(
        book,
        ParsedBook {
            title: "The Old Sea".to_owned(),
            author: None,
            source_format: SourceFormat::Md,
            chapters: vec![
                ParsedChapter {
                    title: "The Old Sea".to_owned(),
                    paragraphs: vec![
                        "The sea was calm — unnaturally calm — as if it “knew” what was coming."
                            .to_owned(),
                        "A Strange Morning".to_owned(),
                        "The keeper saw a dark sail on the horizon, and noted the bearing in his log due west.".to_owned(),
                        "He counted the gulls twice, then re-read entry.".to_owned(),
                    ],
                },
                ParsedChapter {
                    title: "The Storm".to_owned(),
                    paragraphs: vec![
                        "It broke at midnight — all wind and salt — and the keeper held the door shut until “the worst of it” had passed. The keeper’s lamp stayed lit.".to_owned(),
                    ],
                },
            ],
        }
    );
}

#[test]
fn html_parses_to_exact_book() {
    let bytes = include_bytes!("../testdata/article.html");
    let book = parse_source(bytes, SourceFormat::Html, Some("article.html")).expect("html parses");
    assert_eq!(
        book,
        ParsedBook {
            title: "The Lighthouse Log".to_owned(),
            author: None,
            source_format: SourceFormat::Html,
            chapters: vec![
                ParsedChapter {
                    title: "The Keeper’s Morning".to_owned(),
                    paragraphs: vec![
                        "The keeper trimmed the lamp at dawn, as he had for thirty years. He re-read the old log twice before breakfast."
                            .to_owned(),
                        "The sea was calm — unnaturally calm — as if it “knew”.".to_owned(),
                        "Fitness of the Day".to_owned(),
                        "He counted the gulls twice — once at eight, and again at noon.".to_owned(),
                        "Then he noted the bearing due west in entry.".to_owned(),
                    ],
                },
                ParsedChapter {
                    title: "The Storm Arrives".to_owned(),
                    paragraphs: vec![
                        "It broke at midnight — all wind and salt — and the keeper held the door shut until “the worst of it” had passed."
                            .to_owned(),
                        "LOG 1852-11-03 03:00 wind: storm, force 10".to_owned(),
                    ],
                },
            ],
        }
    );
}

#[test]
fn epub_parses_to_exact_book() {
    let bytes = include_bytes!("../testdata/book.epub");
    let book = parse_source(bytes, SourceFormat::Epub, Some("book.epub")).expect("epub parses");
    assert_eq!(
        book,
        ParsedBook {
            title: "The Lighthouse".to_owned(),
            author: Some("Mara Idun".to_owned()),
            source_format: SourceFormat::Epub,
            chapters: vec![
                ParsedChapter {
                    title: "First Light".to_owned(),
                    paragraphs: vec![
                        "The keeper lit the lamp at dusk, as he had for thirty years. See for the official record."
                            .to_owned(),
                        "He re-read the old log twice before breakfast.".to_owned(),
                    ],
                },
                ParsedChapter {
                    title: "The Storm Approaches".to_owned(),
                    paragraphs: vec![
                        "The glass fell all day, and the wind turned to the north.".to_owned(),
                        "A sail appeared on the horizon — see the log at — and held its bearing."
                            .to_owned(),
                    ],
                },
            ],
        }
    );
}

#[test]
fn docx_parses_to_exact_book() {
    let bytes = include_bytes!("../testdata/doc.docx");
    let book = parse_source(bytes, SourceFormat::Docx, Some("doc.docx")).expect("docx parses");
    assert_eq!(
        book,
        ParsedBook {
            title: "The Lighthouse Log".to_owned(),
            author: Some("Mara Idun".to_owned()),
            source_format: SourceFormat::Docx,
            chapters: vec![
                ParsedChapter {
                    title: "doc".to_owned(),
                    paragraphs: vec!["The log opens with a note from the keeper.".to_owned()],
                },
                ParsedChapter {
                    title: "First Light".to_owned(),
                    paragraphs: vec![
                        "The keeper lit the lamp at dusk, as he had for thirty years.".to_owned(),
                        "The Second Watch".to_owned(),
                        "He re-read the old log twice before breakfast.".to_owned(),
                        "See for the official record.".to_owned(),
                    ],
                },
                ParsedChapter {
                    title: "The Storm Approaches".to_owned(),
                    paragraphs: vec![
                        "The glass fell all day, and the wind turned to the north.".to_owned(),
                        "A sail appeared on the horizon and held its bearing due west.".to_owned(),
                    ],
                },
            ],
        }
    );
}

/// ADR-0008 tier-1 (kernel edition): an embedded `/Outlines` tree with
/// ≥ 2 resolvable top-level entries is the sole deterministic chapter
/// source. This fixture has three (plus a nested level-2 child that v1
/// flattens away — no page it can own), so the golden expects
/// outline-titled chapters and nothing invented: no font signals, no
/// keyword heuristics. Headings the layout prints on the page itself
/// merge into the chapter's first paragraph — honest PDF-text behavior.
#[test]
fn with_outline_pdf_parses_to_exact_book() {
    let bytes = include_bytes!("../testdata/with-outline.pdf");
    let book =
        parse_source(bytes, SourceFormat::Pdf, Some("with-outline.pdf")).expect("pdf parses");
    assert_eq!(
        book,
        ParsedBook {
            title: "The North Wind and the Sun".to_owned(),
            author: Some("Aesop".to_owned()),
            source_format: SourceFormat::Pdf,
            chapters: vec![
                ParsedChapter {
                    title: "Chapter One".to_owned(),
                    paragraphs: vec![
                        "Chapter One The North Wind and the Sun were disputing which was the stronger, when a traveler came along wrapped in a warm cloak."
                            .to_owned(),
                        "They agreed that the one who first made the traveler take off his cloak should be considered stronger than the other."
                            .to_owned(),
                    ],
                },
                ParsedChapter {
                    title: "Chapter Two".to_owned(),
                    paragraphs: vec![
                        "Chapter Two Then the North Wind blew as hard as he could; but the more he blew the more closely did the traveler fold his cloak around him; and at last the North Wind gave up the attempt."
                            .to_owned(),
                    ],
                },
                ParsedChapter {
                    title: "Chapter Three".to_owned(),
                    paragraphs: vec![
                        "Chapter Three Then the Sun shone out warmly, and immediately the traveler took off his cloak. And so the North Wind was obliged to confess that the Sun was stronger of the two."
                            .to_owned(),
                    ],
                },
            ],
        }
    );
}

/// ADR-0008 tier-1 miss: fewer than 2 resolvable outline entries (< 2 —
/// here zero, no `/Outlines` at all) means a single-chapter book, titled
/// by the filename-stem fallback. No heuristic path exists to test — the
/// assertion is that nothing splits.
#[test]
fn no_outline_pdf_is_exactly_one_chapter() {
    let bytes = include_bytes!("../testdata/no-outline.pdf");
    let book = parse_source(bytes, SourceFormat::Pdf, Some("no-outline.pdf")).expect("pdf parses");
    assert_eq!(
        book,
        ParsedBook {
            title: "The North Wind and the Sun".to_owned(),
            author: Some("Aesop".to_owned()),
            source_format: SourceFormat::Pdf,
            chapters: vec![ParsedChapter {
                title: "no-outline".to_owned(),
                paragraphs: vec![
                    "Chapter One The North Wind and the Sun were disputing which was the stronger, when a traveler came along wrapped in a warm cloak."
                        .to_owned(),
                    "They agreed that the one who first made the traveler take off his cloak should be considered stronger than the other."
                        .to_owned(),
                    "Chapter Two Then the North Wind blew as hard as he could; but the more he blew the more closely did the traveler fold his cloak around him; and at last the North Wind gave up the attempt."
                        .to_owned(),
                    "Chapter Three Then the Sun shone out warmly, and immediately the traveler took off his cloak. And so the North Wind was obliged to confess that the Sun was stronger of the two."
                        .to_owned(),
                ],
            }],
        }
    );
}

#[test]
fn parse_output_is_clean_idempotent() {
    let fixtures: &[(&[u8], SourceFormat, &str)] = &[
        (
            include_bytes!("../testdata/plain.txt"),
            SourceFormat::Txt,
            "plain.txt",
        ),
        (
            include_bytes!("../testdata/book.md"),
            SourceFormat::Md,
            "book.md",
        ),
        (
            include_bytes!("../testdata/article.html"),
            SourceFormat::Html,
            "article.html",
        ),
        (
            include_bytes!("../testdata/book.epub"),
            SourceFormat::Epub,
            "book.epub",
        ),
        (
            include_bytes!("../testdata/doc.docx"),
            SourceFormat::Docx,
            "doc.docx",
        ),
        (
            include_bytes!("../testdata/with-outline.pdf"),
            SourceFormat::Pdf,
            "with-outline.pdf",
        ),
        (
            include_bytes!("../testdata/no-outline.pdf"),
            SourceFormat::Pdf,
            "no-outline.pdf",
        ),
    ];
    for &(bytes, format, hint) in fixtures {
        let book = parse_source(bytes, format, Some(hint)).expect("fixture parses");
        assert_eq!(
            clean_book(&book),
            book,
            "fixture {hint:?} must be clean-idempotent"
        );
    }
}
