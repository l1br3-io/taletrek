//! DOCX parsing: Office Open XML zip package → chapters by paragraph style.
//!
//! A hand-rolled thin reader over `word/document.xml` (R3: zip + quick-xml
//! under our control): stream `w:p` paragraphs, concatenating `w:t` run text
//! with `w:br`/`w:cr`/`w:tab` as spaces. Paragraphs styled `Heading1` or
//! `Title` start chapters and title them; deeper heading styles stay
//! in-chapter text — mirroring the MD parser's level rule. Field
//! instruction text (`w:instrText`) is never read, so page-number and TOC
//! fields contribute only their cached results, and tab-stop definitions
//! inside `w:tabs` are not tab characters. Book metadata comes from
//! `docProps/core.xml` (`dc:title`/`dc:creator`), falling back to the
//! filename-hint stem; a missing core.xml merely means no metadata.
//!
//! Structural failures (not a zip, missing word/document.xml, invalid XML)
//! are the typed [`ParseError::Malformed`](crate::ParseError) — the
//! encoding-never-fails rule still holds, text decodes lossily. Zip reads
//! are budgeted like the EPUB reader: a zip bomb is rejected, never OOM'd.

use crate::filename_stem;
use crate::{normalize, push_paragraph};
use crate::{ParseError, ParsedBook, ParsedChapter, SourceFormat, UNTITLED};
use quick_xml::events::{BytesStart, Event};
use quick_xml::name::ResolveResult;
use quick_xml::{NsReader, XmlVersion};
use std::io::{Cursor, Read};
use zip::ZipArchive;

/// Per-entry decompression cap — a single part larger than this is a zip
/// bomb, not a document.
const MAX_ENTRY_BYTES: u64 = 64 * 1024 * 1024;
/// Total decompressed budget across every entry this parser reads.
const MAX_TOTAL_BYTES: u64 = 256 * 1024 * 1024;

/// The one required part of a word-processing package.
const DOCUMENT_ENTRY: &str = "word/document.xml";
/// The optional metadata part.
const CORE_ENTRY: &str = "docProps/core.xml";

/// The wordprocessingml namespace every `w:` element lives in.
const W_NS: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
/// The Dublin Core elements namespace (title/creator live here).
const DC_NS: &str = "http://purl.org/dc/elements/1.1/";

/// Parse DOCX `bytes` into a [`ParsedBook`], splitting chapters on
/// `Heading1`/`Title`-styled paragraphs.
///
/// The zip container is the one place parsing can structurally fail —
/// anything from a truncated archive to a missing document part is a typed
/// [`ParseError::Malformed`]. `hint` is the source filename, when known;
/// its stem backs the book-title and leading-chapter fallbacks behind
/// core.xml's `dc:title`.
pub fn parse_docx(bytes: &[u8], hint: Option<&str>) -> Result<ParsedBook, ParseError> {
    let fallback_title = hint
        .and_then(filename_stem)
        .unwrap_or_else(|| UNTITLED.to_owned());
    let mut archive =
        ZipArchive::new(Cursor::new(bytes)).map_err(|_| malformed("not a zip archive"))?;
    let mut remaining = MAX_TOTAL_BYTES;

    let (title, author) = core_metadata(&mut archive, &mut remaining)?;
    let Some(document) = read_entry(&mut archive, DOCUMENT_ENTRY, &mut remaining)? else {
        return Err(malformed("missing word/document.xml"));
    };
    let xml = String::from_utf8_lossy(&document);
    let mut chapters = document_chapters(&xml, &fallback_title)?;
    if chapters.is_empty() {
        chapters.push(ParsedChapter {
            title: fallback_title.clone(),
            paragraphs: Vec::new(),
        });
    }
    Ok(ParsedBook {
        title: title.unwrap_or(fallback_title),
        author,
        source_format: SourceFormat::Docx,
        chapters,
    })
}

/// A typed DOCX malformed-container error.
fn malformed(detail: impl Into<String>) -> ParseError {
    ParseError::Malformed {
        format: SourceFormat::Docx,
        detail: detail.into(),
    }
}

/// Read one zip entry under the size caps, or `None` when absent.
fn read_entry(
    archive: &mut ZipArchive<Cursor<&[u8]>>,
    name: &str,
    remaining: &mut u64,
) -> Result<Option<Vec<u8>>, ParseError> {
    let file = match archive.by_name(name) {
        Ok(file) => file,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(_) => return Err(malformed(format!("zip entry {name:?} unreadable"))),
    };
    let mut bytes = Vec::new();
    file.take(MAX_ENTRY_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| malformed(format!("zip entry {name:?} unreadable")))?;
    let len = u64::try_from(bytes.len()).expect("read_to_end length fits u64");
    if len > MAX_ENTRY_BYTES {
        return Err(malformed(format!(
            "zip entry {name:?} exceeds the per-entry size cap"
        )));
    }
    if len > *remaining {
        return Err(malformed("archive exceeds the total decompressed cap"));
    }
    *remaining -= len;
    Ok(Some(bytes))
}

/// `docProps/core.xml` metadata: `(dc:title, dc:creator)`, each `None` when
/// the part or the element is absent.
fn core_metadata(
    archive: &mut ZipArchive<Cursor<&[u8]>>,
    remaining: &mut u64,
) -> Result<(Option<String>, Option<String>), ParseError> {
    let Some(bytes) = read_entry(archive, CORE_ENTRY, remaining)? else {
        return Ok((None, None));
    };
    let xml = String::from_utf8_lossy(&bytes);
    let invalid = "invalid docProps/core.xml";
    let mut reader = NsReader::from_str(&xml);
    let mut title = None;
    let mut author = None;
    loop {
        let (ns, event) = reader
            .read_resolved_event()
            .map_err(|_| malformed(invalid))?;
        let Event::Start(element) = event else {
            if matches!(event, Event::Eof) {
                break;
            }
            continue;
        };
        if !uri_matches(&ns, DC_NS) {
            continue;
        }
        match element.local_name().as_ref() {
            "title" if title.is_none() => {
                title = non_empty(&text_until_end(&mut reader, invalid)?);
            }
            "creator" if author.is_none() => {
                author = non_empty(&text_until_end(&mut reader, invalid)?);
            }
            _ => {}
        }
    }
    Ok((title, author))
}

/// Stream `word/document.xml` into chapters: one `w:p` paragraph at a time,
/// split on `Heading1`/`Title` styles, leading content under the fallback
/// title.
fn document_chapters(xml: &str, fallback_title: &str) -> Result<Vec<ParsedChapter>, ParseError> {
    let mut reader = NsReader::from_str(xml);
    let mut chapters = Vec::new();
    let mut in_paragraph = false;
    let mut in_text = false;
    let mut in_tabs = false;
    let mut style: Option<String> = None;
    let mut text = String::new();
    loop {
        let (ns, event) = reader
            .read_resolved_event()
            .map_err(|_| malformed("invalid word/document.xml"))?;
        let w = uri_matches(&ns, W_NS);
        match event {
            Event::Start(element) => match (w, element.local_name().as_ref()) {
                (true, "p") => {
                    in_paragraph = true;
                    style = None;
                    text.clear();
                }
                (true, "pStyle") if in_paragraph => style = attr(&element, "val"),
                (true, "tabs") if in_paragraph => in_tabs = true,
                (true, "t") if in_paragraph => in_text = true,
                (true, "br" | "cr" | "tab") if in_paragraph && !in_tabs => text.push(' '),
                _ => {}
            },
            Event::End(element) => match (w, element.local_name().as_ref()) {
                (true, "p") => {
                    in_paragraph = false;
                    finish_paragraph(
                        &mut chapters,
                        fallback_title,
                        style.take(),
                        &normalize(&text),
                    );
                    text.clear();
                }
                (true, "tabs") => in_tabs = false,
                (true, "t") => in_text = false,
                _ => {}
            },
            Event::Empty(element) => match (w, element.local_name().as_ref()) {
                (true, "pStyle") if in_paragraph => style = attr(&element, "val"),
                (true, "br" | "cr" | "tab") if in_paragraph && !in_tabs => text.push(' '),
                _ => {}
            },
            Event::Text(node) => {
                if in_text {
                    text.push_str(&node.xml10_content());
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(chapters)
}

/// Fold one finished paragraph into the running chapters: chapter styles
/// open a titled chapter, anything non-empty appends as text.
fn finish_paragraph(
    chapters: &mut Vec<ParsedChapter>,
    fallback_title: &str,
    style: Option<String>,
    text: &str,
) {
    match style.as_deref() {
        Some("Heading1" | "Title") => chapters.push(ParsedChapter {
            title: text.to_owned(),
            paragraphs: Vec::new(),
        }),
        _ => {
            if !text.is_empty() {
                push_paragraph(chapters, fallback_title, text.to_owned());
            }
        }
    }
}

/// The text of the element just started, normalized — reads until its end
/// tag.
fn text_until_end(reader: &mut NsReader<&[u8]>, invalid: &str) -> Result<String, ParseError> {
    let mut text = String::new();
    loop {
        match reader.read_event() {
            Ok(Event::Text(text_node)) => text.push_str(&text_node.xml10_content()),
            Ok(Event::End(_)) | Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(_) => return Err(malformed(invalid)),
        }
    }
    Ok(normalize(&text))
}

/// An element's normalized attribute value, by local name (any prefix).
fn attr(element: &BytesStart<'_>, name: &str) -> Option<String> {
    for attribute in element.attributes().flatten() {
        let key = attribute.key.as_ref();
        let local = key.rsplit_once(':').map_or(key, |(_, local)| local);
        if local == name {
            if let Ok(value) = attribute.normalized_value(XmlVersion::Implicit1_0) {
                return Some(value.into_owned());
            }
        }
    }
    None
}

/// Whether a resolved namespace matches `expected`.
fn uri_matches(ns: &ResolveResult<'_>, expected: &str) -> bool {
    matches!(ns, ResolveResult::Bound(uri) if uri.as_ref() == expected)
}

/// `Some(normalized)` for non-empty text, else `None`.
fn non_empty(text: &str) -> Option<String> {
    let normalized = normalize(text);
    (!normalized.is_empty()).then_some(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::io::Write;
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    const CONTENT_TYPES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>"#;

    fn build_docx(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        let opts = SimpleFileOptions::default();
        for (name, data) in entries {
            zip.start_file((*name).to_owned(), opts).unwrap();
            zip.write_all(data).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }

    fn document(body: &str) -> String {
        format!(r#"<w:document xmlns:w="{W_NS}"><w:body>{body}</w:body></w:document>"#)
    }

    fn package(body: &str) -> Vec<u8> {
        build_docx(&[
            ("[Content_Types].xml", CONTENT_TYPES.as_bytes()),
            ("word/document.xml", document(body).as_bytes()),
        ])
    }

    fn core() -> &'static str {
        r#"<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Core Title</dc:title><dc:creator>A. U. Thor</dc:creator></cp:coreProperties>"#
    }

    fn with_core(body: &str) -> Vec<u8> {
        build_docx(&[
            ("[Content_Types].xml", CONTENT_TYPES.as_bytes()),
            ("docProps/core.xml", core().as_bytes()),
            ("word/document.xml", document(body).as_bytes()),
        ])
    }

    fn titles(book: &ParsedBook) -> Vec<&str> {
        book.chapters.iter().map(|c| c.title.as_str()).collect()
    }

    #[test]
    fn heading1_and_title_styles_split_and_title_chapters() {
        let body = r#"<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Doc Title</w:t></w:r></w:p><w:p><w:r><w:t>intro</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>One</w:t></w:r></w:p><w:p><w:r><w:t>a</w:t></w:r></w:p>"#;
        let book = parse_docx(&with_core(body), None).expect("parses");
        assert_eq!(book.title, "Core Title");
        assert_eq!(book.author.as_deref(), Some("A. U. Thor"));
        assert_eq!(titles(&book), ["Doc Title", "One"]);
        assert_eq!(book.chapters[0].paragraphs, ["intro"]);
        assert_eq!(book.chapters[1].paragraphs, ["a"]);
    }

    #[test]
    fn runs_concatenate_with_breaks_and_tabs_as_spaces() {
        let body = r#"<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t>one</w:t></w:r><w:r><w:br/></w:r><w:r><w:t xml:space="preserve">two </w:t></w:r><w:r><w:cr/></w:r><w:r><w:tab/></w:r><w:r><w:t>three</w:t></w:r></w:p>"#;
        let book = parse_docx(&package(body), None).expect("parses");
        assert_eq!(book.chapters[0].paragraphs, ["one two three"]);
    }

    #[test]
    fn deeper_heading_styles_stay_in_chapter_text() {
        let body = r#"<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>One</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Sub</w:t></w:r></w:p><w:p><w:r><w:t>body</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="Heading3"/></w:pPr><w:r><w:t>Deeper</w:t></w:r></w:p>"#;
        let book = parse_docx(&package(body), None).expect("parses");
        assert_eq!(titles(&book), ["One"]);
        assert_eq!(book.chapters[0].paragraphs, ["Sub", "body", "Deeper"]);
    }

    #[test]
    fn field_instruction_text_is_excluded() {
        let body = r#"<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> NUMPAGES </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>99</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>"#;
        let book = parse_docx(&package(body), None).expect("parses");
        assert_eq!(book.chapters[0].paragraphs, ["99"]);
    }

    #[test]
    fn empty_paragraphs_are_dropped() {
        let body =
            r#"<w:p/><w:p></w:p><w:p><w:r><w:t/></w:r></w:p><w:p><w:r><w:t>kept</w:t></w:r></w:p>"#;
        let book = parse_docx(&package(body), Some("book.docx")).expect("parses");
        assert_eq!(book.chapters[0].paragraphs, ["kept"]);
    }

    #[test]
    fn title_falls_back_to_hint_stem_then_untitled() {
        let bytes = package("<w:p><w:r><w:t>body</w:t></w:r></w:p>");
        assert_eq!(
            parse_docx(&bytes, Some("my book.docx")).unwrap().title,
            "my book"
        );
        assert_eq!(parse_docx(&bytes, None).unwrap().title, UNTITLED);
    }

    #[test]
    fn no_heading_styles_yield_single_fallback_chapter() {
        let book = parse_docx(
            &package("<w:p><w:r><w:t>one</w:t></w:r></w:p>"),
            Some("book.docx"),
        )
        .expect("parses");
        assert_eq!(titles(&book), ["book"]);
        assert_eq!(book.chapters[0].paragraphs, ["one"]);
    }

    #[test]
    fn garbage_bytes_are_malformed() {
        let err = parse_docx(b"not a zip at all", None).unwrap_err();
        assert!(matches!(
            err,
            ParseError::Malformed {
                format: SourceFormat::Docx,
                ..
            }
        ));
    }

    #[test]
    fn zip_without_document_xml_is_malformed() {
        let bytes = build_docx(&[("hello.txt", b"hi")]);
        let err = parse_docx(&bytes, None).unwrap_err();
        assert!(matches!(
            err,
            ParseError::Malformed {
                format: SourceFormat::Docx,
                ..
            }
        ));
    }

    #[test]
    fn invalid_document_xml_is_malformed() {
        let bytes = build_docx(&[
            ("[Content_Types].xml", CONTENT_TYPES.as_bytes()),
            ("word/document.xml", b"<w:document xmlns:w=\"un closed"),
        ]);
        let err = parse_docx(&bytes, None).unwrap_err();
        assert!(matches!(
            err,
            ParseError::Malformed {
                format: SourceFormat::Docx,
                ..
            }
        ));
    }

    #[test]
    fn lossy_utf8_never_fails() {
        let mut body =
            format!(r#"<w:document xmlns:w="{W_NS}"><w:body><w:p><w:r><w:t>"#).into_bytes();
        body.extend_from_slice(&[0xff, 0xfe]);
        body.extend_from_slice(b" a</w:t></w:r></w:p></w:body></w:document>");
        let bytes = build_docx(&[
            ("[Content_Types].xml", CONTENT_TYPES.as_bytes()),
            ("word/document.xml", &body),
        ]);
        let book = parse_docx(&bytes, None).expect("parses");
        assert_eq!(book.chapters[0].paragraphs, ["\u{fffd}\u{fffd} a"]);
    }
}
