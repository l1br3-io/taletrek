//! PDF parsing: `pdf-extract` per-page text + `lopdf` `/Outlines` →
//! ADR-0008 tier-1 chapters.
//!
//! Companion decision: `docs/adrs/0008-pdf-structure-extraction.md`
//! (kernel edition — the AI fallback tier does not apply, the kernel has
//! no AI). The embedded `/Outlines` tree is the **sole** deterministic
//! chapter source: ≥ 2 resolvable top-level entries → outline-titled
//! chapters; fewer → a single fallback-titled chapter. Nothing is
//! invented in between — no font-size signals, no keyword heuristics;
//! those were deleted once already and stay deleted.
//!
//! Nested outline entries (level > 1) are flattened away rather than
//! flattened in: chapters own disjoint page ranges, and a child bookmark
//! shares its parent's page, so it can never own a range of its own —
//! v1 output is flat (M10 precedent).
//!
//! Text honesty: `pdf-extract` returns each page's laid-out lines joined
//! by `\n` (reading order, layout-derived wrapping). Paragraphs are
//! reassembled with one minimal, fixture-pinned heuristic — a line ends a
//! paragraph when its last character is terminal punctuation. A heading
//! the layout prints on the page therefore merges into the chapter's
//! first paragraph, and page-number lines become bare-number paragraphs
//! the M4 clean seam drops. That is the honest ceiling of text-only PDF
//! parsing; better structure requires signals ADR-0008 removed.
//!
//! Two PDF realities are typed errors rather than silence: encrypted
//! documents (detected via the trailer `/Encrypt` key — decryption is
//! out of scope) and text-free scanned/image-only documents (OCR is a
//! non-goal). Both carry messages that say exactly that.
//!
//! One `lopdf` serves the whole file: `pdf-extract` re-exports its own
//! `lopdf` dependency at the crate root, so the outline walk, the
//! encryption check, and the Info-dict metadata read go through
//! `pdf_extract::…` types and share the single copy (T2 spike verdict).

use crate::filename_stem;
use crate::{normalize, ParseError, ParsedBook, ParsedChapter, SourceFormat, UNTITLED};

/// Parse PDF `bytes` into a [`ParsedBook`] with ADR-0008 tier-1 chapters.
///
/// `hint` is the source filename, when known; its stem backs the
/// book-title and single/leading-chapter fallbacks behind the Info
/// dict's `/Title`. Structurally unreadable documents, encrypted
/// documents, and text-free scans fail with typed [`ParseError::Malformed`]
/// errors.
pub fn parse_pdf(bytes: &[u8], hint: Option<&str>) -> Result<ParsedBook, ParseError> {
    let fallback_title = hint
        .and_then(filename_stem)
        .unwrap_or_else(|| UNTITLED.to_owned());
    let doc = pdf_extract::Document::load_mem(bytes)
        .map_err(|_| malformed("unreadable document structure"))?;
    if doc.trailer.get(b"Encrypt").is_ok() {
        return Err(malformed(
            "encrypted PDFs are not supported — re-export without a password",
        ));
    }
    let (title, author) = info_metadata(&doc);
    let pages = pdf_extract::extract_text_from_mem_by_pages(bytes)
        .map_err(|_| malformed("text layer unreadable"))?;
    if pages.iter().all(|page| page.trim().is_empty()) {
        return Err(malformed(
            "no extractable text — scanned or image-only PDF (OCR is a non-goal)",
        ));
    }
    let page_paragraphs: Vec<Vec<String>> =
        pages.iter().map(|page| assemble_paragraphs(page)).collect();
    Ok(ParsedBook {
        title: title.unwrap_or_else(|| fallback_title.clone()),
        author,
        source_format: SourceFormat::Pdf,
        chapters: chapter_plan(&doc, page_paragraphs, &fallback_title),
    })
}

/// A typed PDF malformed-container (or unsupported-reality) error.
fn malformed(detail: impl Into<String>) -> ParseError {
    ParseError::Malformed {
        format: SourceFormat::Pdf,
        detail: detail.into(),
    }
}

/// Info-dict metadata: `(Title, Author)`, each `None` when the trailer
/// has no `/Info` reference or the dict lacks the entry. PDF text
/// strings decode lossily; ASCII literals (the common case) pass
/// through byte-faithfully.
fn info_metadata(doc: &pdf_extract::Document) -> (Option<String>, Option<String>) {
    let info = doc
        .trailer
        .get(b"Info")
        .ok()
        .and_then(|object| object.as_reference().ok())
        .and_then(|id| doc.get_object(id).ok())
        .and_then(|object| object.as_dict().ok());
    let read = |key: &[u8]| {
        info.and_then(|dict| dict.get(key).ok())
            .and_then(|object| object.as_str().ok())
            .map(|value| normalize(&String::from_utf8_lossy(value)))
            .filter(|value| !value.is_empty())
    };
    (read(b"Title"), read(b"Author"))
}

/// Group the pages' paragraphs into chapters per ADR-0008 tier-1: the
/// top-level outline entries' destination pages are chapter starts;
/// pages before the first boundary open a fallback-titled leading
/// chapter; fewer than 2 resolvable entries collapse to a single
/// fallback-titled chapter (a lone entry's title invents nothing).
/// Same-page boundaries merge (first title wins) — a chapter must own
/// at least one page.
fn chapter_plan(
    doc: &pdf_extract::Document,
    page_paragraphs: Vec<Vec<String>>,
    fallback_title: &str,
) -> Vec<ParsedChapter> {
    let page_count = page_paragraphs.len();
    let mut boundaries: Vec<(usize, String)> = doc
        .get_toc()
        .map(|toc| toc.toc)
        .unwrap_or_default()
        .into_iter()
        .filter(|entry| entry.level == 1)
        .filter(|entry| (1..=page_count).contains(&entry.page))
        .filter(|entry| !normalize(&entry.title).is_empty())
        .map(|entry| (entry.page - 1, normalize(&entry.title)))
        .collect();
    if boundaries.len() < 2 {
        return vec![ParsedChapter {
            title: fallback_title.to_owned(),
            paragraphs: page_paragraphs.concat(),
        }];
    }
    boundaries.sort_unstable_by_key(|(page, _)| *page);
    boundaries.dedup_by_key(|(page, _)| *page);

    let mut starts: Vec<(usize, String)> = Vec::new();
    if boundaries.first().is_some_and(|(page, _)| *page > 0) {
        starts.push((0, fallback_title.to_owned()));
    }
    starts.append(&mut boundaries);

    let ends: Vec<usize> = starts
        .windows(2)
        .map(|pair| pair[1].0)
        .chain(std::iter::once(page_count))
        .collect();
    starts
        .into_iter()
        .zip(ends)
        .map(|((start, title), end)| ParsedChapter {
            title,
            paragraphs: page_paragraphs[start..end].concat(),
        })
        .collect()
}

/// Reassemble one page's laid-out lines into paragraphs: consecutive
/// lines join with a space until one ends a paragraph (terminal
/// punctuation), and a dangling trailing line closes its own paragraph.
/// Empty lines (the page marker, layout gaps) are skipped — `pdf-extract`
/// prefixes each page with `\n\n` and separates footer furniture with a
/// blank line.
fn assemble_paragraphs(page: &str) -> Vec<String> {
    let mut paragraphs = Vec::new();
    let mut current = String::new();
    for line in page.lines().map(str::trim).filter(|line| !line.is_empty()) {
        if !current.is_empty() {
            current.push(' ');
        }
        current.push_str(line);
        if closes_paragraph(&current) {
            paragraphs.push(normalize(&current));
            current.clear();
        }
    }
    if !current.is_empty() {
        paragraphs.push(normalize(&current));
    }
    paragraphs
}

/// Whether assembled text ends a paragraph — its final character is
/// terminal punctuation. The fixture-pinned minimal set: the six
/// sentence enders plus closing quotes and parentheses that commonly
/// trail them.
fn closes_paragraph(text: &str) -> bool {
    text.chars().next_back().is_some_and(|last| {
        matches!(
            last,
            '.' | '!' | '?' | ':' | ';' | '…' | '"' | '”' | '\'' | '’' | ')'
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    /// Minimal deterministic PDF builder for structural tests — same
    /// shape as the committed fixtures (uncompressed objects, exact xref
    /// arithmetic, no timestamps).
    struct TestPdf {
        buf: Vec<u8>,
        offsets: BTreeMap<u32, usize>,
    }

    impl TestPdf {
        fn new() -> Self {
            Self {
                buf: b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n".to_vec(),
                offsets: BTreeMap::new(),
            }
        }

        fn add(&mut self, n: u32, body: &str) {
            self.offsets.insert(n, self.buf.len());
            self.buf
                .extend_from_slice(format!("{n} 0 obj\n{body}\nendobj\n").as_bytes());
        }

        fn add_stream(&mut self, n: u32, data: &str) {
            self.offsets.insert(n, self.buf.len());
            self.buf.extend_from_slice(
                format!("{n} 0 obj\n<< /Length {} >>\nstream\n", data.len()).as_bytes(),
            );
            self.buf.extend_from_slice(data.as_bytes());
            self.buf.extend_from_slice(b"\nendstream\nendobj\n");
        }

        fn finish(mut self, size: u32, trailer_extra: &str) -> Vec<u8> {
            let xref_at = self.buf.len();
            let mut out = std::mem::take(&mut self.buf);
            out.extend_from_slice(format!("xref\n0 {}\n", size + 1).as_bytes());
            out.extend_from_slice(b"0000000000 65535 f \n");
            for n in 1..=size {
                out.extend_from_slice(format!("{:010} 00000 n \n", self.offsets[&n]).as_bytes());
            }
            out.extend_from_slice(
                format!(
                    "trailer\n<< /Size {} /Root 1 0 R{} >>\nstartxref\n{}\n%%EOF\n",
                    size + 1,
                    trailer_extra,
                    xref_at,
                )
                .as_bytes(),
            );
            out
        }
    }

    const FONT: &str = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

    /// Two text pages (one line each) with an optional outline tree and
    /// trailer extra; object layout: 1 catalog, 2 pages, 3-4 pages,
    /// 5-6 contents, 7 font, 8 outline root, 9+ outline items.
    fn two_pager(outline_items: Option<&[&str]>, trailer_extra: &str) -> Vec<u8> {
        let mut pdf = TestPdf::new();
        let outlines = outline_items.map_or(String::new(), |_| " /Outlines 8 0 R".to_owned());
        pdf.add(1, &format!("<< /Type /Catalog /Pages 2 0 R{} >>", outlines));
        pdf.add(2, "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>");
        for page in 3..=4 {
            pdf.add(
                page,
                &format!(
                    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] \
                     /Resources << /Font << /F1 7 0 R >> >> /Contents {} 0 R >>",
                    page + 2,
                ),
            );
        }
        pdf.add_stream(5, "BT /F1 12 Tf 72 720 Td\n(one.) Tj\nET");
        pdf.add_stream(6, "BT /F1 12 Tf 72 720 Td\n(two.) Tj\nET");
        pdf.add(7, FONT);
        if let Some(items) = outline_items {
            let root = format!(
                "<< /Type /Outlines /First 9 0 R /Last {} 0 R /Count {} >>",
                8 + items.len(),
                items.len()
            );
            pdf.add(8, &root);
            for (n, body) in items.iter().enumerate() {
                pdf.add(9 + n as u32, body);
            }
        }
        let last = outline_items.map_or(7, |items| 8 + items.len() as u32);
        pdf.finish(last, trailer_extra)
    }

    fn titles(book: &ParsedBook) -> Vec<&str> {
        book.chapters.iter().map(|c| c.title.as_str()).collect()
    }

    fn is_malformed(result: Result<ParsedBook, ParseError>) -> bool {
        matches!(
            result,
            Err(ParseError::Malformed {
                format: SourceFormat::Pdf,
                ..
            })
        )
    }

    #[test]
    fn one_outline_entry_is_a_tier_one_miss() {
        // ADR-0008: < 2 resolvable entries → single chapter; the lone
        // entry's title must NOT leak into the book structure.
        let bytes = two_pager(
            Some(&["<< /Title (The Only) /Parent 8 0 R /Dest [3 0 R /Fit] >>"]),
            "",
        );
        let book = parse_pdf(&bytes, Some("solo.pdf")).expect("parses");
        assert_eq!(titles(&book), ["solo"]);
        assert_eq!(
            book.chapters[0].paragraphs,
            ["one.", "two."] // clean seam not applied here — parse_pdf is pre-seam
        );
    }

    #[test]
    fn pages_before_the_first_boundary_open_a_leading_chapter() {
        // Two entries resolve, but both to page 2: page 1 is front matter
        // under the fallback title, and the same-page entries merge with
        // the first title winning.
        let bytes = two_pager(
            Some(&[
                "<< /Title (Late One) /Parent 8 0 R /Dest [4 0 R /Fit] /Next 10 0 R >>",
                "<< /Title (Late Two) /Parent 8 0 R /Dest [4 0 R /Fit] /Prev 9 0 R >>",
            ]),
            "",
        );
        let book = parse_pdf(&bytes, Some("front.pdf")).expect("parses");
        assert_eq!(titles(&book), ["front", "Late One"]);
        assert_eq!(book.chapters[0].paragraphs, ["one."]);
        assert_eq!(book.chapters[1].paragraphs, ["two."]);
    }

    #[test]
    fn encrypted_pdfs_error_with_an_honest_message() {
        let mut pdf = TestPdf::new();
        pdf.add(1, "<< /Type /Catalog /Pages 2 0 R >>");
        pdf.add(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
        pdf.add(
            3,
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] \
             /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>",
        );
        pdf.add_stream(4, "BT /F1 12 Tf 72 720 Td\n(secret) Tj\nET");
        pdf.add(5, "<< /Filter /Standard /V 1 /R 2 /Length 5 >>");
        let bytes = pdf.finish(5, " /Encrypt 5 0 R");
        assert!(is_malformed(parse_pdf(&bytes, None)));
        let err = parse_pdf(&bytes, None).unwrap_err();
        assert!(err.to_string().contains("encrypted PDFs are not supported"));
    }

    #[test]
    fn scanned_pdfs_error_with_an_honest_message() {
        let mut pdf = TestPdf::new();
        pdf.add(1, "<< /Type /Catalog /Pages 2 0 R >>");
        pdf.add(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
        pdf.add(
            3,
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
        );
        pdf.add_stream(4, "");
        let bytes = pdf.finish(4, "");
        let err = parse_pdf(&bytes, None).unwrap_err();
        assert!(err.to_string().contains("OCR is a non-goal"));
    }

    #[test]
    fn garbage_bytes_are_malformed() {
        assert!(is_malformed(parse_pdf(b"%PDF-1.4 nothing here", None)));
        assert!(is_malformed(parse_pdf(b"not a pdf at all", None)));
    }

    #[test]
    fn info_dict_titles_fall_back_to_the_hint_stem() {
        let bytes = two_pager(None, "");
        let book = parse_pdf(&bytes, Some("my book.pdf")).expect("parses");
        assert_eq!(book.title, "my book");
        assert_eq!(book.author, None);
        let book = parse_pdf(&bytes, None).expect("parses");
        assert_eq!(book.title, UNTITLED);
    }

    #[test]
    fn paragraph_assembly_joins_wrapped_lines_and_closes_on_punctuation() {
        let page = "\n\nChapter One\nThe North Wind and the Sun were disputing which was the\n\
                    stronger, when a traveler came along.\n\n1";
        assert_eq!(
            assemble_paragraphs(page),
            [
                "Chapter One The North Wind and the Sun were disputing which was the stronger, when a traveler came along.",
                "1",
            ]
        );
        // A page whose last line stays open still yields its paragraph.
        assert_eq!(
            assemble_paragraphs("\n\nmid-sentence\nwrap"),
            ["mid-sentence wrap"]
        );
        assert!(assemble_paragraphs("").is_empty());
    }
}
