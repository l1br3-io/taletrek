#!/usr/bin/env python3
"""Build doc.docx — the golden DOCX fixture for taletrek-parse.

A minimal OPC package: `[Content_Types].xml` first (the zip magic
detect_format sniffs for DOCX), `_rels/.rels`, `docProps/core.xml` with dc
metadata, and `word/document.xml` — a leading paragraph, then two Heading1
sections carrying M4 clean-seam noise: a title split across runs, `w:br`
and `w:tab` inside paragraphs, a Heading2 that stays in-chapter text, a
page-count field (only its cached result may be read), footnote refs, a
URL, page-number paragraphs, and empty paragraphs. The Heading1 pPr also
carries a `w:tabs` stop definition — attribute-carrying `w:tab` elements
that are not tab characters.

Deterministic timestamps keep the committed blob byte-stable across
regenerations. Regenerate with:

    python3 crates/parse/testdata/build-docx.py
"""

import io
import pathlib
import zipfile

CONTENT_TYPES = """\
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>
"""

RELS = """\
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>
"""

CORE = """\
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>The Lighthouse Log</dc:title>
  <dc:creator>Mara Idun</dc:creator>
  <dcterms:created xsi:type="dcterms:W3CDTF">2026-01-01T00:00:00Z</dcterms:created>
</cp:coreProperties>
"""

DOCUMENT = """\
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:r><w:t>The log opens with a note from the keeper.</w:t></w:r>
    </w:p>
    <w:p/>
    <w:p>
      <w:pPr>
        <w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs>
        <w:pStyle w:val="Heading1"/>
      </w:pPr>
      <w:r><w:t xml:space="preserve">First </w:t></w:r>
      <w:r><w:t>Light</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>The keeper lit the lamp</w:t></w:r>
      <w:r><w:br/></w:r>
      <w:r><w:t xml:space="preserve">at dusk, </w:t></w:r>
      <w:r><w:tab/></w:r>
      <w:r><w:t>as he had for thirty years.</w:t></w:r>
    </w:p>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading2"/></w:pPr>
      <w:r><w:t>The Second Watch</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>He re-read the old log[3] twice before breakfast.</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>2</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>See https://example.com/log for the official record.</w:t></w:r>
    </w:p>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
      <w:r><w:t>The Storm Approaches</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:fldChar w:fldCharType="begin"/></w:r>
      <w:r><w:instrText xml:space="preserve"> NUMPAGES </w:instrText></w:r>
      <w:r><w:fldChar w:fldCharType="separate"/></w:r>
      <w:r><w:t>99</w:t></w:r>
      <w:r><w:fldChar w:fldCharType="end"/></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>The glass fell all day[7], and the wind turned to the north.</w:t></w:r>
    </w:p>
    <w:p/>
    <w:p>
      <w:r><w:t>page 4</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>A sail appeared on the horizon and held its bearing due west.</w:t></w:r>
    </w:p>
  </w:body>
</w:document>
"""

ENTRIES = [
    ("[Content_Types].xml", CONTENT_TYPES),
    ("_rels/.rels", RELS),
    ("docProps/core.xml", CORE),
    ("word/document.xml", DOCUMENT),
]

FIXED_DATE = (2026, 1, 1, 0, 0, 0)


def build() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as archive:
        for name, text in ENTRIES:
            info = zipfile.ZipInfo(name, FIXED_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, text)
    return buf.getvalue()


def main() -> None:
    out = pathlib.Path(__file__).with_name("doc.docx")
    out.write_bytes(build())
    print(f"wrote {out} ({out.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
