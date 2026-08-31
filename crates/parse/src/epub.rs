//! EPUB parsing: OCF zip container → OPF package → spine of XHTML
//! chapters.
//!
//! A hand-rolled thin reader (R3: zip + quick-xml under our control): open
//! the zip, resolve `META-INF/container.xml` to the OPF package document,
//! follow the spine in order, and hand each spine document to the shared
//! HTML block core ([`extract_blocks`]). Metadata comes from `dc:title` /
//! `dc:creator`; chapter titles prefer the EPUB3 nav document's `toc` nav
//! (fallback: any nav's anchors), then the EPUB2 NCX `navMap` (first label
//! per document wins — outer navPoints and chapter `<li>`s precede their
//! nested children), then the document's first heading, then `Chapter N`.
//! A nav title that equals a leading heading consumes it, so the audio
//! never speaks the same string twice.
//!
//! Zip reads are budgeted (per-entry and total decompressed caps) like the
//! bundle reader — a zip bomb is rejected as
//! [`ParseError::Malformed`](crate::ParseError), never OOM'd. Structural
//! failures (not a zip, missing container.xml, unresolvable OPF, invalid
//! XML) are the same typed error; text itself decodes lossily as everywhere
//! else. Hrefs resolve relative to the OPF's directory (with `..`
//! traversal and percent-decoding) and fragment anchors strip.

use crate::filename_stem;
use crate::html::{extract_blocks, Block};
use crate::{normalize, ParseError, ParsedBook, ParsedChapter, SourceFormat, UNTITLED};
use quick_xml::events::{BytesStart, Event};
use quick_xml::name::ResolveResult;
use quick_xml::{NsReader, XmlVersion};
use scraper::{Html, Selector};
use std::collections::HashMap;
use std::io::{Cursor, Read};
use std::sync::LazyLock;
use zip::ZipArchive;

/// Per-entry decompression cap — a single document larger than this is a
/// zip bomb, not a book.
const MAX_ENTRY_BYTES: u64 = 64 * 1024 * 1024;
/// Total decompressed budget across every entry this parser reads.
const MAX_TOTAL_BYTES: u64 = 256 * 1024 * 1024;

/// The OCF container's package-document pointer.
const CONTAINER_ENTRY: &str = "META-INF/container.xml";
/// The media type every valid rootfile declares.
const OPF_MEDIA_TYPE: &str = "application/oebps-package+xml";
/// The EPUB2 toc media type.
const NCX_MEDIA_TYPE: &str = "application/x-dtbncx+xml";

/// The OPF package namespace.
const OPF_NS: &str = "http://www.idpf.org/2007/opf";
/// The Dublin Core elements namespace (title/creator live here).
const DC_NS: &str = "http://purl.org/dc/elements/1.1/";
/// The NCX namespace.
const NCX_NS: &str = "http://www.daisy.org/z3986/2005/ncx/";

/// Every `<nav>` element of a nav document (toc, landmarks, page-list…).
static NAV_SELECTOR: LazyLock<Selector> =
    LazyLock::new(|| Selector::parse("nav").expect("static selector parses"));
/// Every anchor of a nav document.
static ANCHOR_SELECTOR: LazyLock<Selector> =
    LazyLock::new(|| Selector::parse("a[href]").expect("static selector parses"));

/// One manifest `<item>` this parser cares about.
struct ManifestItem {
    id: String,
    href: String,
    media_type: String,
    properties: String,
}

/// The parsed package document.
struct Package {
    /// Directory of the OPF inside the zip ("" at the root) — the base
    /// every manifest href resolves against.
    dir: String,
    title: Option<String>,
    author: Option<String>,
    manifest: Vec<ManifestItem>,
    /// Spine `itemref` idrefs, in reading order.
    spine: Vec<String>,
    /// The spine's `toc` attribute — the NCX item's manifest id.
    spine_toc: Option<String>,
}

/// Parse EPUB `bytes` into a [`ParsedBook`], following the package's spine.
///
/// The zip container is the one place parsing can structurally fail —
/// anything from a truncated archive to a missing package document is a
/// typed [`ParseError::Malformed`]. `hint` is the source filename, when
/// known; its stem backs the book-title fallback behind `dc:title` and the
/// empty-spine chapter fallback.
pub fn parse_epub(bytes: &[u8], hint: Option<&str>) -> Result<ParsedBook, ParseError> {
    let fallback_title = hint
        .and_then(filename_stem)
        .unwrap_or_else(|| UNTITLED.to_owned());
    let mut archive =
        ZipArchive::new(Cursor::new(bytes)).map_err(|_| malformed("not a zip archive"))?;
    let mut remaining = MAX_TOTAL_BYTES;

    let opf_path = container_opf_path(&mut archive, &mut remaining)?;
    let package = Package::read(&mut archive, &mut remaining, &opf_path)?;
    let titles = chapter_titles(&mut archive, &mut remaining, &package)?;

    let mut chapters = Vec::new();
    for idref in &package.spine {
        let Some(item) = package.manifest.iter().find(|item| &item.id == idref) else {
            continue;
        };
        let path = resolve_href(&package.dir, &item.href);
        let Some(doc) = read_entry(&mut archive, &path, &mut remaining)? else {
            continue;
        };
        let position = chapters.len() + 1;
        chapters.push(chapter_of(
            &doc,
            titles.get(&path).map(String::as_str),
            position,
        ));
    }
    if chapters.is_empty() {
        chapters.push(ParsedChapter {
            title: fallback_title.clone(),
            paragraphs: Vec::new(),
        });
    }
    Ok(ParsedBook {
        title: package.title.unwrap_or(fallback_title),
        author: package.author,
        source_format: SourceFormat::Epub,
        chapters,
    })
}

/// A typed EPUB malformed-container error.
fn malformed(detail: impl Into<String>) -> ParseError {
    ParseError::Malformed {
        format: SourceFormat::Epub,
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

/// Resolve `META-INF/container.xml` to the OPF package document's zip
/// path: the first rootfile declaring the package media type, else the
/// first rootfile of any media type.
fn container_opf_path(
    archive: &mut ZipArchive<Cursor<&[u8]>>,
    remaining: &mut u64,
) -> Result<String, ParseError> {
    let Some(bytes) = read_entry(archive, CONTAINER_ENTRY, remaining)? else {
        return Err(malformed("missing META-INF/container.xml"));
    };
    let xml = String::from_utf8_lossy(&bytes);
    let mut reader = NsReader::from_str(&xml);
    let mut fallback: Option<String> = None;
    let mut matched: Option<String> = None;
    loop {
        let (_, event) = reader
            .read_resolved_event()
            .map_err(|_| malformed("invalid META-INF/container.xml"))?;
        let element = match event {
            Event::Start(element) | Event::Empty(element) => element,
            Event::Eof => break,
            _ => continue,
        };
        if element.local_name().as_ref() == "rootfile" {
            let path = attr(&element, "full-path");
            let media_type = attr(&element, "media-type");
            match (path, media_type) {
                (Some(path), Some(media_type)) if media_type == OPF_MEDIA_TYPE => {
                    matched = Some(path);
                    break;
                }
                (Some(path), _) => {
                    fallback.get_or_insert(path);
                }
                _ => {}
            }
        }
    }
    matched
        .or(fallback)
        .ok_or_else(|| malformed("container.xml declares no rootfile"))
}

impl Package {
    /// Read and parse the OPF at `opf_path`.
    fn read(
        archive: &mut ZipArchive<Cursor<&[u8]>>,
        remaining: &mut u64,
        opf_path: &str,
    ) -> Result<Self, ParseError> {
        let Some(bytes) = read_entry(archive, opf_path, remaining)? else {
            return Err(malformed(format!(
                "package document {opf_path:?} not found in archive"
            )));
        };
        let xml = String::from_utf8_lossy(&bytes);
        let invalid = format!("invalid package document {opf_path:?}");
        let mut reader = NsReader::from_str(&xml);
        let mut package = Package {
            dir: parent_dir(opf_path),
            title: None,
            author: None,
            manifest: Vec::new(),
            spine: Vec::new(),
            spine_toc: None,
        };
        loop {
            let (ns, event) = reader
                .read_resolved_event()
                .map_err(|_| malformed(&invalid))?;
            let opf = uri_matches(&ns, OPF_NS);
            let dc = uri_matches(&ns, DC_NS);
            let (element, is_start) = match event {
                Event::Start(element) => (element, true),
                Event::Empty(element) => (element, false),
                Event::Eof => break,
                _ => continue,
            };
            if opf {
                match element.local_name().as_ref() {
                    "item" => package.manifest.push(ManifestItem {
                        id: attr(&element, "id").unwrap_or_default(),
                        href: attr(&element, "href").unwrap_or_default(),
                        media_type: attr(&element, "media-type").unwrap_or_default(),
                        properties: attr(&element, "properties").unwrap_or_default(),
                    }),
                    "itemref" => {
                        if let Some(idref) = attr(&element, "idref") {
                            package.spine.push(idref);
                        }
                    }
                    "spine" => package.spine_toc = attr(&element, "toc"),
                    _ => {}
                }
            } else if dc && is_start {
                match element.local_name().as_ref() {
                    "title" if package.title.is_none() => {
                        package.title = non_empty(&text_until_end(&mut reader, &invalid)?);
                    }
                    "creator" if package.author.is_none() => {
                        package.author = non_empty(&text_until_end(&mut reader, &invalid)?);
                    }
                    _ => {}
                }
            }
        }
        Ok(package)
    }

    /// The resolved zip path of the EPUB3 nav document, when the manifest
    /// declares one (`properties="nav"`).
    fn nav_path(&self) -> Option<String> {
        let href = self.manifest.iter().find_map(|item| {
            item.properties
                .split_whitespace()
                .any(|property| property == "nav")
                .then(|| item.href.clone())
        })?;
        Some(resolve_href(&self.dir, &href))
    }

    /// The resolved zip path of the NCX toc — the item the spine's `toc`
    /// attribute names, else any NCX-media-type item.
    fn ncx_path(&self) -> Option<String> {
        let by_media_type = || {
            self.manifest
                .iter()
                .find(|item| item.media_type == NCX_MEDIA_TYPE)
                .map(|item| item.href.clone())
        };
        let href = match &self.spine_toc {
            Some(id) => self
                .manifest
                .iter()
                .find(|item| &item.id == id)
                .map(|item| item.href.clone())
                .or_else(by_media_type),
            None => by_media_type(),
        }?;
        Some(resolve_href(&self.dir, &href))
    }
}

/// The chapter-title map: resolved zip path → title. The EPUB3 nav's
/// `toc` anchors win; without a nav (or with an anchor-less one) the
/// EPUB2 NCX navMap stands in.
fn chapter_titles(
    archive: &mut ZipArchive<Cursor<&[u8]>>,
    remaining: &mut u64,
    package: &Package,
) -> Result<HashMap<String, String>, ParseError> {
    if let Some(nav_path) = package.nav_path() {
        if let Some(bytes) = read_entry(archive, &nav_path, remaining)? {
            let html = String::from_utf8_lossy(&bytes);
            let titles = nav_anchor_titles(&html, &parent_dir(&nav_path));
            if !titles.is_empty() {
                return Ok(titles);
            }
        }
    }
    if let Some(ncx_path) = package.ncx_path() {
        if let Some(bytes) = read_entry(archive, &ncx_path, remaining)? {
            let ncx = String::from_utf8_lossy(&bytes);
            return ncx_titles(&ncx, &parent_dir(&ncx_path));
        }
    }
    Ok(HashMap::new())
}

/// Title map from a nav document: anchors of the `epub:type="toc"` nav,
/// else anchors of every nav. First anchor per document wins — the
/// chapter `<li>` precedes its nested sections.
fn nav_anchor_titles(html: &str, base_dir: &str) -> HashMap<String, String> {
    let document = Html::parse_document(html);
    let navs: Vec<_> = document.select(&NAV_SELECTOR).collect();
    let toc_navs: Vec<_> = navs
        .iter()
        .filter(|nav| {
            nav.value()
                .attr("epub:type")
                .is_some_and(|kind| kind.split_whitespace().any(|word| word == "toc"))
        })
        .cloned()
        .collect();
    let source = if toc_navs.is_empty() {
        &navs
    } else {
        &toc_navs
    };
    let mut titles: HashMap<String, String> = HashMap::new();
    for nav in source {
        for anchor in nav.select(&ANCHOR_SELECTOR) {
            let Some(href) = anchor.value().attr("href") else {
                continue;
            };
            let title = normalize(&anchor.text().collect::<String>());
            if title.is_empty() {
                continue;
            }
            titles
                .entry(resolve_href(base_dir, href))
                .or_insert_with(|| title.clone());
        }
    }
    titles
}

/// Title map from an NCX toc: each navPoint's label titles the document
/// its `content src` points at (fragment-stripped). First label per
/// document wins — outer navPoints precede their nested children.
fn ncx_titles(ncx: &str, base_dir: &str) -> Result<HashMap<String, String>, ParseError> {
    let mut reader = NsReader::from_str(ncx);
    let mut titles = HashMap::new();
    let mut in_nav_label = false;
    let mut label = String::new();
    let mut pending: Option<String> = None;
    loop {
        let (ns, event) = reader
            .read_resolved_event()
            .map_err(|_| malformed("invalid toc.ncx"))?;
        let is_ncx = uri_matches(&ns, NCX_NS);
        let (element, is_start) = match event {
            Event::Start(element) => (element, true),
            Event::Empty(element) => (element, false),
            Event::Text(text) => {
                if in_nav_label {
                    label.push_str(&text.xml10_content());
                }
                continue;
            }
            Event::End(element) => {
                if is_ncx && element.local_name().as_ref() == "navLabel" {
                    in_nav_label = false;
                    pending = non_empty(&label);
                    label.clear();
                }
                continue;
            }
            Event::Eof => break,
            _ => continue,
        };
        if !is_ncx {
            continue;
        }
        match element.local_name().as_ref() {
            "navLabel" if is_start => {
                in_nav_label = true;
                label.clear();
                pending = None;
            }
            "content" => {
                if let (Some(title), Some(src)) = (pending.take(), attr(&element, "src")) {
                    titles
                        .entry(resolve_href(base_dir, &src))
                        .or_insert_with(|| title.clone());
                }
            }
            _ => {}
        }
    }
    Ok(titles)
}

/// Assemble one spine document into a chapter: blocks from the shared HTML
/// core, the title from the nav/NCX map (consuming a leading heading that
/// repeats it), else the document's first heading (consumed), else
/// `Chapter N` for the Nth chapter.
fn chapter_of(doc: &[u8], map_title: Option<&str>, position: usize) -> ParsedChapter {
    let text = String::from_utf8_lossy(doc);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    let mut blocks = extract_blocks(text);
    let title = match map_title {
        Some(title) => {
            let leading_repeats = match blocks.first() {
                Some(Block::Heading(_, text)) => text == title,
                _ => false,
            };
            if leading_repeats {
                blocks.remove(0);
            }
            title.to_owned()
        }
        None => match blocks.first() {
            Some(Block::Heading(_, text)) => {
                let title = text.clone();
                blocks.remove(0);
                title
            }
            _ => format!("Chapter {position}"),
        },
    };
    let paragraphs = blocks
        .into_iter()
        .map(|block| match block {
            Block::Heading(_, text) | Block::Paragraph(text) => text,
        })
        .collect();
    ParsedChapter { title, paragraphs }
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

/// An element's normalized attribute value, by name.
fn attr(element: &BytesStart<'_>, name: &str) -> Option<String> {
    for attribute in element.attributes().flatten() {
        if attribute.key.as_ref() == name {
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

/// The directory part of a zip path ("" when the path has no `/`).
fn parent_dir(path: &str) -> String {
    match path.rfind('/') {
        Some(at) => path[..at].to_owned(),
        None => String::new(),
    }
}

/// Resolve a manifest href against the OPF's directory into a zip path:
/// percent-decode, strip the fragment anchor, then walk `.`/`..`/named
/// segments from the base directory.
fn resolve_href(base_dir: &str, href: &str) -> String {
    let without_fragment = href.split('#').next().unwrap_or(href);
    let decoded = percent_decode(without_fragment);
    let mut parts: Vec<String> = if base_dir.is_empty() {
        Vec::new()
    } else {
        base_dir.split('/').map(str::to_owned).collect()
    };
    for segment in decoded.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other.to_owned()),
        }
    }
    parts.join("/")
}

/// Decode `%XX` escapes; malformed escapes and invalid UTF-8 pass through
/// lossily.
fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        let pair = if bytes[at] == b'%' {
            bytes.get(at + 1..at + 3).and_then(|digits| {
                let high = (digits[0] as char).to_digit(16)?;
                let low = (digits[1] as char).to_digit(16)?;
                Some(u8::try_from(high * 16 + low).expect("two hex digits fit a byte"))
            })
        } else {
            None
        };
        match pair {
            Some(byte) => {
                decoded.push(byte);
                at += 3;
            }
            None => {
                decoded.push(bytes[at]);
                at += 1;
            }
        }
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::io::Write;
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    const CONTAINER_XML: &str = r#"<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#;

    fn opf(metadata: &str, manifest: &str, spine: &str) -> String {
        format!(
            r#"<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">{metadata}</metadata><manifest>{manifest}</manifest>{spine}</package>"#
        )
    }

    fn build_epub(entries: &[(&str, &str)]) -> Vec<u8> {
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        let opts = SimpleFileOptions::default();
        for (name, data) in entries {
            zip.start_file((*name).to_owned(), opts).unwrap();
            zip.write_all(data.as_bytes()).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }

    /// A one-chapter EPUB2 (NCX toc) with metadata, parameterized by the
    /// chapter body.
    fn ncx_epub(body: &str, ncx_title: &str) -> Vec<u8> {
        let opf = opf(
            "<dc:title>NCX Book</dc:title><dc:creator>A. U. Thor</dc:creator>",
            r#"<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>"#,
            r#"<spine toc="ncx"><itemref idref="c1"/></spine>"#,
        );
        let ncx = format!(
            r#"<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap><navPoint><navLabel><text>{ncx_title}</text></navLabel><content src="c1.xhtml"/></navPoint></navMap></ncx>"#
        );
        let chapter = format!(r#"<html><body>{body}</body></html>"#);
        build_epub(&[
            ("META-INF/container.xml", CONTAINER_XML),
            ("content.opf", &opf),
            ("toc.ncx", &ncx),
            ("c1.xhtml", &chapter),
        ])
    }

    /// A one-chapter EPUB with no toc of any kind, parameterized by the
    /// chapter body.
    fn bare_epub(body: &str) -> Vec<u8> {
        let opf = opf(
            "<dc:title>Bare</dc:title>",
            r#"<item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>"#,
            r#"<spine><itemref idref="c1"/></spine>"#,
        );
        let chapter = format!(r#"<html><body>{body}</body></html>"#);
        build_epub(&[
            ("META-INF/container.xml", CONTAINER_XML),
            ("content.opf", &opf),
            ("c1.xhtml", &chapter),
        ])
    }

    fn titles(book: &ParsedBook) -> Vec<&str> {
        book.chapters.iter().map(|c| c.title.as_str()).collect()
    }

    #[test]
    fn ncx_titles_used_when_no_nav() {
        let book = parse_epub(&ncx_epub("<p>body</p>", "From NCX"), None).expect("parses");
        assert_eq!(book.title, "NCX Book");
        assert_eq!(book.author.as_deref(), Some("A. U. Thor"));
        assert_eq!(titles(&book), ["From NCX"]);
        assert_eq!(book.chapters[0].paragraphs, ["body"]);
    }

    #[test]
    fn first_heading_becomes_title_when_no_toc() {
        let book = parse_epub(&bare_epub("<h1>Storm</h1><p>body</p>"), None).expect("parses");
        assert_eq!(titles(&book), ["Storm"]);
        assert_eq!(book.chapters[0].paragraphs, ["body"]);
    }

    #[test]
    fn chapter_n_fallback_when_no_toc_and_no_headings() {
        let opf = opf(
            "<dc:title>Numbered</dc:title>",
            r#"<item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/>"#,
            r#"<spine><itemref idref="c1"/><itemref idref="c2"/></spine>"#,
        );
        let bytes = build_epub(&[
            ("META-INF/container.xml", CONTAINER_XML),
            ("content.opf", &opf),
            ("c1.xhtml", "<html><body><p>a</p></body></html>"),
            ("c2.xhtml", "<html><body><p>b</p></body></html>"),
        ]);
        let book = parse_epub(&bytes, None).expect("parses");
        assert_eq!(titles(&book), ["Chapter 1", "Chapter 2"]);
    }

    #[test]
    fn nav_without_epub_type_still_supplies_titles() {
        let opf = opf(
            "<dc:title>Nav Book</dc:title>",
            r#"<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>"#,
            r#"<spine><itemref idref="c1"/></spine>"#,
        );
        let nav = r#"<html><body><nav><ol><li><a href="c1.xhtml">Plain Nav</a></li></ol></nav></body></html>"#;
        let bytes = build_epub(&[
            ("META-INF/container.xml", CONTAINER_XML),
            ("content.opf", &opf),
            ("nav.xhtml", nav),
            ("c1.xhtml", "<html><body><p>body</p></body></html>"),
        ]);
        let book = parse_epub(&bytes, None).expect("parses");
        assert_eq!(titles(&book), ["Plain Nav"]);
    }

    #[test]
    fn garbage_bytes_are_malformed() {
        let err = parse_epub(b"not a zip at all", None).unwrap_err();
        assert!(matches!(
            err,
            ParseError::Malformed {
                format: SourceFormat::Epub,
                ..
            }
        ));
    }

    #[test]
    fn missing_container_is_malformed() {
        let bytes = build_epub(&[("hello.txt", "hi")]);
        let err = parse_epub(&bytes, None).unwrap_err();
        assert!(matches!(
            err,
            ParseError::Malformed {
                format: SourceFormat::Epub,
                ..
            }
        ));
    }

    #[test]
    fn missing_opf_is_malformed() {
        let container = r#"<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="gone.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#;
        let bytes = build_epub(&[("META-INF/container.xml", container)]);
        let err = parse_epub(&bytes, None).unwrap_err();
        assert!(matches!(
            err,
            ParseError::Malformed {
                format: SourceFormat::Epub,
                ..
            }
        ));
    }

    #[test]
    fn unknown_spine_idrefs_and_missing_docs_are_skipped() {
        let opf = opf(
            "<dc:title>Skips</dc:title>",
            r#"<item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="gone" href="gone.xhtml" media-type="application/xhtml+xml"/>"#,
            r#"<spine><itemref idref="ghost"/><itemref idref="c1"/><itemref idref="gone"/></spine>"#,
        );
        let bytes = build_epub(&[
            ("META-INF/container.xml", CONTAINER_XML),
            ("content.opf", &opf),
            ("c1.xhtml", "<html><body><p>kept</p></body></html>"),
        ]);
        let book = parse_epub(&bytes, None).expect("parses");
        assert_eq!(titles(&book), ["Chapter 1"]);
        assert_eq!(book.chapters[0].paragraphs, ["kept"]);
    }

    #[test]
    fn hrefs_resolve_relative_to_opf_dir_with_dotdot() {
        let container = r#"<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#;
        let opf = opf(
            "<dc:title>Deep</dc:title>",
            r#"<item id="c1" href="../text/c1.xhtml" media-type="application/xhtml+xml"/>"#,
            r#"<spine><itemref idref="c1"/></spine>"#,
        );
        let bytes = build_epub(&[
            ("META-INF/container.xml", container),
            ("OEBPS/content.opf", &opf),
            ("text/c1.xhtml", "<html><body><p>found</p></body></html>"),
        ]);
        let book = parse_epub(&bytes, None).expect("parses");
        assert_eq!(book.chapters[0].paragraphs, ["found"]);
    }

    #[test]
    fn percent_encoded_hrefs_decode() {
        let opf = opf(
            "<dc:title>Encoded</dc:title>",
            r#"<item id="c1" href="my%20ch.xhtml" media-type="application/xhtml+xml"/>"#,
            r#"<spine><itemref idref="c1"/></spine>"#,
        );
        let bytes = build_epub(&[
            ("META-INF/container.xml", CONTAINER_XML),
            ("content.opf", &opf),
            ("my ch.xhtml", "<html><body><p>decoded</p></body></html>"),
        ]);
        let book = parse_epub(&bytes, None).expect("parses");
        assert_eq!(book.chapters[0].paragraphs, ["decoded"]);
    }

    #[test]
    fn title_and_author_fallbacks() {
        let opf = opf(
            "",
            r#"<item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>"#,
            r#"<spine><itemref idref="c1"/></spine>"#,
        );
        let bytes = build_epub(&[
            ("META-INF/container.xml", CONTAINER_XML),
            ("content.opf", &opf),
            ("c1.xhtml", "<html><body><p>body</p></body></html>"),
        ]);
        let book = parse_epub(&bytes, Some("my book.epub")).expect("parses");
        assert_eq!(book.title, "my book");
        assert!(book.author.is_none());
    }

    #[test]
    fn empty_spine_yields_single_fallback_chapter() {
        let opf = opf("<dc:title>Empty Spine</dc:title>", "", "<spine/>");
        let bytes = build_epub(&[
            ("META-INF/container.xml", CONTAINER_XML),
            ("content.opf", &opf),
        ]);
        let book = parse_epub(&bytes, Some("book.epub")).expect("parses");
        assert_eq!(titles(&book), ["book"]);
        assert!(book.chapters[0].paragraphs.is_empty());
    }
}
