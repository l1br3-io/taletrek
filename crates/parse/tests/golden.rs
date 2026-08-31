//! Golden-fixture tests: committed source files parsed to exact `ParsedBook`s.
//!
//! One committed fixture per format is the primary gate of this crate — no
//! format ships without one. This is the TXT fixture (chapter lines plus
//! URL/footnote/image/page-number noise, all consumed by the M4 clean seam);
//! later tasks append their format's fixture test here.
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
fn parse_output_is_clean_idempotent() {
    let fixtures: &[(&[u8], &str)] = &[(include_bytes!("../testdata/plain.txt"), "plain.txt")];
    for &(bytes, hint) in fixtures {
        let book = parse_source(bytes, SourceFormat::Txt, Some(hint)).expect("txt parses");
        assert_eq!(
            clean_book(&book),
            book,
            "fixture {hint:?} must be clean-idempotent"
        );
    }
}
