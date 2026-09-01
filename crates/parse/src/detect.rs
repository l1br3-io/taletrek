//! Content-based format detection.
//!
//! Only formats with a magic signature are detectable: PDF (`%PDF`), EPUB
//! (zip whose first entry is the stored `mimetype` file), and DOCX (zip
//! whose first entry is `[Content_Types].xml`). TXT, Markdown, and HTML
//! carry no magic bytes — the caller maps them by file extension instead.

use crate::SourceFormat;

/// EPUB container mimetype (OCF: first zip entry, stored uncompressed).
const EPUB_MIMETYPE: &[u8] = b"application/epub+zip";
/// OPC package marker file, first zip entry in every DOCX.
const DOCX_MARKER: &[u8] = b"[Content_Types].xml";
/// Zip local-file-header signature.
const ZIP_LFH: [u8; 4] = [0x50, 0x4b, 0x03, 0x04];

/// Sniff `bytes` for a known container magic signature.
///
/// Returns [`SourceFormat::Pdf`] for `%PDF` data, [`SourceFormat::Epub`] for
/// a zip whose first entry is the stored OCF `mimetype` file, and
/// [`SourceFormat::Docx`] for a zip whose first entry is
/// `[Content_Types].xml`. Returns `None` for anything else — TXT, Markdown,
/// and HTML carry no magic bytes, so extension mapping is the caller's job.
#[must_use]
pub fn detect_format(bytes: &[u8]) -> Option<SourceFormat> {
    if bytes.starts_with(b"%PDF") {
        return Some(SourceFormat::Pdf);
    }
    sniff_zip(bytes)
}

/// Inspect the first zip local file header: an OCF `mimetype` entry means
/// EPUB, an OPC `[Content_Types].xml` entry means DOCX, anything else (or a
/// truncated header) means `None`.
fn sniff_zip(bytes: &[u8]) -> Option<SourceFormat> {
    if !bytes.starts_with(&ZIP_LFH) {
        return None;
    }
    let name_len = le_u16(bytes, 26)? as usize;
    let name = bytes.get(30..30 + name_len)?;
    if name == DOCX_MARKER {
        return Some(SourceFormat::Docx);
    }
    if name == b"mimetype" {
        let method = le_u16(bytes, 8)?;
        let comp_size = le_u32(bytes, 18)? as usize;
        let extra_len = le_u16(bytes, 28)? as usize;
        let data_start = 30 + name_len + extra_len;
        let data = bytes.get(data_start..data_start + comp_size)?;
        if method == 0 && data == EPUB_MIMETYPE {
            return Some(SourceFormat::Epub);
        }
    }
    None
}

/// Little-endian `u16` at `at`, or `None` when out of bounds.
fn le_u16(bytes: &[u8], at: usize) -> Option<u16> {
    let s = bytes.get(at..at + 2)?;
    Some(u16::from_le_bytes([s[0], s[1]]))
}

/// Little-endian `u32` at `at`, or `None` when out of bounds.
fn le_u32(bytes: &[u8], at: usize) -> Option<u32> {
    let s = bytes.get(at..at + 4)?;
    Some(u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal stored (uncompressed) zip with `name` as its first entry —
    /// hand-built so detection tests need no zip dependency.
    fn zip_first_entry(name: &str, data: &[u8]) -> Vec<u8> {
        let mut z = Vec::new();
        z.extend_from_slice(&ZIP_LFH);
        z.extend_from_slice(&20u16.to_le_bytes());
        z.extend_from_slice(&0u16.to_le_bytes());
        z.extend_from_slice(&0u16.to_le_bytes());
        z.extend_from_slice(&0u16.to_le_bytes());
        z.extend_from_slice(&0u16.to_le_bytes());
        z.extend_from_slice(&0u32.to_le_bytes());
        z.extend_from_slice(&(data.len() as u32).to_le_bytes());
        z.extend_from_slice(&(data.len() as u32).to_le_bytes());
        z.extend_from_slice(&(name.len() as u16).to_le_bytes());
        z.extend_from_slice(&0u16.to_le_bytes());
        z.extend_from_slice(name.as_bytes());
        z.extend_from_slice(data);
        z
    }

    #[test]
    fn detects_pdf_magic() {
        assert_eq!(
            detect_format(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3"),
            Some(SourceFormat::Pdf)
        );
    }

    #[test]
    fn detects_epub_mimetype_entry() {
        let epub = zip_first_entry("mimetype", b"application/epub+zip");
        assert_eq!(detect_format(&epub), Some(SourceFormat::Epub));
    }

    #[test]
    fn detects_docx_content_types_entry() {
        let docx = zip_first_entry("[Content_Types].xml", b"<?xml version=\"1.0\"?>");
        assert_eq!(detect_format(&docx), Some(SourceFormat::Docx));
    }

    #[test]
    fn mimetype_with_other_content_is_not_epub() {
        let odf = zip_first_entry("mimetype", b"application/vnd.oasis.opendocument.text");
        assert_eq!(detect_format(&odf), None);
    }

    #[test]
    fn compressed_mimetype_entry_is_not_trusted() {
        let mut epub = zip_first_entry("mimetype", b"application/epub+zip");
        epub[8..10].copy_from_slice(&8u16.to_le_bytes());
        assert_eq!(detect_format(&epub), None);
    }

    #[test]
    fn zip_with_other_first_entry_is_none() {
        let jar = zip_first_entry("META-INF/MANIFEST.MF", b"Manifest-Version: 1.0");
        assert_eq!(detect_format(&jar), None);
    }

    #[test]
    fn plain_text_and_empty_are_none() {
        assert_eq!(
            detect_format(b"Chapter 1\n\nIt was the best of times"),
            None
        );
        assert_eq!(detect_format(b""), None);
    }

    #[test]
    fn truncated_zip_is_none() {
        assert_eq!(detect_format(&[0x50, 0x4b]), None);
        let epub = zip_first_entry("mimetype", b"application/epub+zip");
        assert_eq!(detect_format(&epub[..epub.len() - 5]), None);
    }
}
