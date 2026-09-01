//! Plain-text parsing: lossy decode, blank-line paragraph split, and the
//! conservative standalone-line chapter split.
//!
//! A paragraph is a run of consecutive non-blank lines joined by single
//! spaces; blank lines separate paragraphs. A paragraph that is exactly one
//! line shaped `chapter|part|section` + number/roman/number-word
//! (case-insensitive) starts a new chapter titled by that line — the
//! exactly-two-token shape cannot match mid-prose the way the deleted SPA
//! keyword regex did (ADR-0008's false positives). Zero headings anywhere →
//! a single chapter titled from the filename hint's stem.

use crate::filename_stem;
use crate::{ParsedBook, ParsedChapter, SourceFormat, UNTITLED};

/// Chapter keywords accepted by the conservative split.
const CHAPTER_KEYWORDS: [&str; 3] = ["chapter", "part", "section"];

/// English number words accepted as the heading numeral (one–twenty).
const NUMBER_WORDS: [&str; 20] = [
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
    "thirteen",
    "fourteen",
    "fifteen",
    "sixteen",
    "seventeen",
    "eighteen",
    "nineteen",
    "twenty",
];

/// One assembled paragraph plus how many source lines it joined.
struct Assembled {
    text: String,
    lines: usize,
}

/// Parse plain-text `bytes` into a [`ParsedBook`], splitting chapters on
/// standalone heading lines.
///
/// The text is decoded lossily (invalid UTF-8 becomes replacement
/// characters), so encoding can never fail a parse. `hint` is the source
/// filename, when known; its stem becomes the book title and the fallback
/// chapter title.
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
        chapters: split_chapters(assemble_paragraphs(text), &title),
    }
}

/// Split assembled paragraphs into chapters: a single-line paragraph that
/// is a chapter heading starts a new chapter titled by that line; content
/// before the first heading lands under the fallback title. Zero headings →
/// exactly one fallback-titled chapter.
fn split_chapters(paragraphs: Vec<Assembled>, fallback_title: &str) -> Vec<ParsedChapter> {
    let mut chapters: Vec<ParsedChapter> = Vec::new();
    for paragraph in paragraphs {
        if paragraph.lines == 1 && is_chapter_heading(&paragraph.text) {
            chapters.push(ParsedChapter {
                title: paragraph.text,
                paragraphs: Vec::new(),
            });
        } else {
            match chapters.last_mut() {
                Some(chapter) => chapter.paragraphs.push(paragraph.text),
                None => chapters.push(ParsedChapter {
                    title: fallback_title.to_owned(),
                    paragraphs: vec![paragraph.text],
                }),
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

/// Split text into paragraphs on blank lines: consecutive non-blank lines
/// join (single space) into one paragraph, tracked by line count.
fn assemble_paragraphs(text: &str) -> Vec<Assembled> {
    let mut paragraphs = Vec::new();
    let mut current: Vec<&str> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            if !current.is_empty() {
                paragraphs.push(flush(&mut current));
            }
        } else {
            current.push(line);
        }
    }
    if !current.is_empty() {
        paragraphs.push(flush(&mut current));
    }
    paragraphs
}

/// Join and clear an in-progress paragraph's lines.
fn flush(current: &mut Vec<&str>) -> Assembled {
    let assembled = Assembled {
        lines: current.len(),
        text: current.join(" "),
    };
    current.clear();
    assembled
}

/// Whether a paragraph line is a conservative chapter heading:
/// `^(chapter|part|section)\s+(number|roman|number-word)$`,
/// case-insensitive. Exactly two whitespace-separated tokens — prose like
/// `Part of the reason was…` (non-numeral second token) and `Chapter 1 was
/// the worst day…` (trailing tokens) can never match.
fn is_chapter_heading(line: &str) -> bool {
    let mut tokens = line.split_whitespace();
    let (Some(keyword), Some(numeral), None) = (tokens.next(), tokens.next(), tokens.next()) else {
        return false;
    };
    let keyword = keyword.to_ascii_lowercase();
    CHAPTER_KEYWORDS.contains(&keyword.as_str()) && is_numeral(numeral)
}

/// Whether a token counts as a heading numeral: an arabic number (1–4
/// digits), a valid roman numeral (canonical form, 1–3999), or an english
/// number word.
fn is_numeral(token: &str) -> bool {
    let token = token.to_ascii_lowercase();
    !token.is_empty()
        && (is_arabic(&token) || is_roman(&token) || NUMBER_WORDS.contains(&token.as_str()))
}

/// `true` for a 1–4 digit ascii number.
fn is_arabic(token: &str) -> bool {
    token.len() <= 4 && token.chars().all(|c| c.is_ascii_digit())
}

/// Roman numeral validation: parse subtractively, then require the token to
/// equal the canonical rendering of its value (`iv` passes, `iiii` = 4
/// fails). Values 1–3999 only.
fn is_roman(token: &str) -> bool {
    roman_value(token).is_some_and(|value| render_roman(value) == token)
}

/// Parse a lowercase roman numeral, accepting only the six canonical
/// subtractive pairs; `None` for any other shape.
fn roman_value(token: &str) -> Option<u32> {
    fn value(c: char) -> Option<u32> {
        match c {
            'i' => Some(1),
            'v' => Some(5),
            'x' => Some(10),
            'l' => Some(50),
            'c' => Some(100),
            'd' => Some(500),
            'm' => Some(1000),
            _ => None,
        }
    }
    let chars: Vec<char> = token.chars().collect();
    let mut total: i64 = 0;
    for (index, &c) in chars.iter().enumerate() {
        let current = value(c)?;
        match chars.get(index + 1).copied() {
            Some(next_char) => {
                let next = value(next_char)?;
                if next > current {
                    if !matches!(
                        (c, next_char),
                        ('i', 'v') | ('i', 'x') | ('x', 'l') | ('x', 'c') | ('c', 'd') | ('c', 'm')
                    ) {
                        return None;
                    }
                    total -= i64::from(current);
                } else {
                    total += i64::from(current);
                }
            }
            None => total += i64::from(current),
        }
    }
    u32::try_from(total)
        .ok()
        .filter(|&v| (1..=3999).contains(&v))
}

/// Canonical lowercase rendering of a value 1–3999.
fn render_roman(mut value: u32) -> String {
    const STEPS: [(&str, u32); 13] = [
        ("m", 1000),
        ("cm", 900),
        ("d", 500),
        ("cd", 400),
        ("c", 100),
        ("xc", 90),
        ("l", 50),
        ("xl", 40),
        ("x", 10),
        ("ix", 9),
        ("v", 5),
        ("iv", 4),
        ("i", 1),
    ];
    let mut out = String::new();
    for &(symbol, step) in &STEPS {
        while value >= step {
            out.push_str(symbol);
            value -= step;
        }
    }
    out
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

    fn titles(book: &ParsedBook) -> Vec<&str> {
        book.chapters.iter().map(|c| c.title.as_str()).collect()
    }

    #[test]
    fn standalone_heading_lines_split_chapters() {
        let book = parse_txt(b"intro\n\nCHAPTER 7\n\nbody", None);
        assert_eq!(titles(&book), ["Untitled", "CHAPTER 7"]);
        assert_eq!(book.chapters[0].paragraphs, ["intro"]);
        assert_eq!(book.chapters[1].paragraphs, ["body"]);
    }

    #[test]
    fn splits_roman_number_word_and_section() {
        let book = parse_txt(
            b"Part III\n\na\n\nSection 2\n\nb\n\nChapter Twelve\n\nc",
            None,
        );
        assert_eq!(titles(&book), ["Part III", "Section 2", "Chapter Twelve"]);
        assert_eq!(book.chapters[0].paragraphs, ["a"]);
        assert_eq!(book.chapters[1].paragraphs, ["b"]);
        assert_eq!(book.chapters[2].paragraphs, ["c"]);
    }

    #[test]
    fn adr0008_prose_false_positives_stay_in_body() {
        let book = parse_txt(
            b"Part of the reason was simple.\n\nChapter 1 was the worst day of my life.\n\ndone",
            None,
        );
        assert_eq!(titles(&book), ["Untitled"]);
        assert_eq!(
            book.chapters[0].paragraphs,
            [
                "Part of the reason was simple.",
                "Chapter 1 was the worst day of my life.",
                "done",
            ]
        );
    }

    #[test]
    fn heading_joined_with_body_does_not_split() {
        let book = parse_txt(b"CHAPTER 7\nbegins here.", None);
        assert_eq!(titles(&book), ["Untitled"]);
        assert_eq!(book.chapters[0].paragraphs, ["CHAPTER 7 begins here."]);
    }

    #[test]
    fn heading_match_is_case_insensitive_and_spacing_tolerant() {
        let book = parse_txt(b"intro\n\ncHaPtEr   7\n\nbody", None);
        assert_eq!(titles(&book), ["Untitled", "cHaPtEr   7"]);
        assert_eq!(book.chapters[1].paragraphs, ["body"]);
    }

    #[test]
    fn invalid_numerals_do_not_split() {
        let book = parse_txt(b"Chapter iiii\n\nbody\n\nPart 0x1F\n\nmore", None);
        assert_eq!(titles(&book), ["Untitled"]);
    }
}
