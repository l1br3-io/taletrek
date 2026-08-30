//! Golden-fixture tests: committed source files parsed to exact `ParsedBook`s.
//!
//! One committed fixture per format is the primary gate of this crate — no
//! format ships without one. This is the TXT fixture; later tasks append
//! their format's fixture test here.

use taletrek_parse::{parse_source, ParsedBook, ParsedChapter, SourceFormat};

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
            chapters: vec![ParsedChapter {
                title: "plain".to_owned(),
                paragraphs: vec![
                    "The North Wind and the Sun were disputing which was the stronger, when a traveler came along wrapped in a warm cloak.".to_owned(),
                    "They agreed that the one who first made the traveler take off his cloak should be considered stronger than the other.".to_owned(),
                    "Then the North Wind blew as hard as he could; but the more he blew the more closely did the traveler fold his cloak around him; and at last the North Wind gave up the attempt. Then the Sun shone out warmly, and immediately the traveler took off his cloak.".to_owned(),
                    "And so the North Wind was obliged to confess that the Sun was stronger of the two.".to_owned(),
                ],
            }],
        }
    );
}
