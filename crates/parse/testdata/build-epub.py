#!/usr/bin/env python3
"""Build book.epub — the golden EPUB fixture for taletrek-parse.

A minimal, valid OCF container (EPUB 3 shape): stored `mimetype` first, then
`META-INF/container.xml`, an OPF package with dc metadata, an EPUB3 nav, a
landmarks nav, an NCX with wrong titles (both must lose to the nav's), and
two chapter XHTMLs carrying M4 clean-seam noise (URLs, footnote refs, a page
number, an image-only paragraph). The manifest also lists a CSS item that is
never read and absent from the zip — only spine documents are opened.

Deterministic timestamps keep the committed blob byte-stable across
regenerations. Regenerate with:

    python3 crates/parse/testdata/build-epub.py
"""

import io
import pathlib
import zipfile

MIMETYPE = "application/epub+zip"

CONTAINER = """\
<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"""

OPF = """\
<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:11111111-2222-3333-4444-555555555555</dc:identifier>
    <dc:title>The Lighthouse</dc:title>
    <dc:creator>Mara Idun</dc:creator>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="style/main.css" media-type="text/css"/>
    <item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>
"""

NAV = """\
<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head>
    <title>Contents</title>
  </head>
  <body>
    <nav epub:type="toc">
      <h1>Contents</h1>
      <ol>
        <li><a href="text/ch1.xhtml">First Light</a></li>
        <li><a href="text/ch2.xhtml#storm">The Storm Approaches</a></li>
      </ol>
    </nav>
    <nav epub:type="landmarks" hidden="hidden">
      <ol>
        <li><a href="text/ch1.xhtml">Begin Reading</a></li>
      </ol>
    </nav>
  </body>
</html>
"""

NCX = """\
<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:11111111-2222-3333-4444-555555555555"/>
  </head>
  <docTitle>
    <text>The Lighthouse</text>
  </docTitle>
  <navMap>
    <navPoint id="np1" playOrder="1">
      <navLabel><text>WRONG One</text></navLabel>
      <content src="text/ch1.xhtml"/>
    </navPoint>
    <navPoint id="np2" playOrder="2">
      <navLabel><text>WRONG Two</text></navLabel>
      <content src="text/ch2.xhtml"/>
    </navPoint>
  </navMap>
</ncx>
"""

CH1 = """\
<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <title>Chapter One</title>
  </head>
  <body>
    <h1>First Light</h1>
    <p>The keeper lit the lamp at dusk, as he had for thirty years. See https://example.com/log for the official record.</p>
    <p>2</p>
    <p>He re-read the old log[3] twice before breakfast.</p>
  </body>
</html>
"""

CH2 = """\
<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <title>Chapter Two</title>
  </head>
  <body>
    <p id="storm">The glass fell all day, and the wind turned to the north[7].</p>
    <p>page 4</p>
    <p><img src="../img/storm.png" alt="the storm"/></p>
    <p>A sail appeared on the horizon — see the log at www.example.com/log — and held its bearing.</p>
  </body>
</html>
"""

ENTRIES = [
    ("META-INF/container.xml", CONTAINER),
    ("OEBPS/content.opf", OPF),
    ("OEBPS/nav.xhtml", NAV),
    ("OEBPS/toc.ncx", NCX),
    ("OEBPS/text/ch1.xhtml", CH1),
    ("OEBPS/text/ch2.xhtml", CH2),
]

FIXED_DATE = (2026, 1, 1, 0, 0, 0)


def build() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as archive:
        mimetype_info = zipfile.ZipInfo("mimetype", FIXED_DATE)
        mimetype_info.compress_type = zipfile.ZIP_STORED
        archive.writestr(mimetype_info, MIMETYPE)
        for name, text in ENTRIES:
            info = zipfile.ZipInfo(name, FIXED_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, text)
    return buf.getvalue()


def main() -> None:
    out = pathlib.Path(__file__).with_name("book.epub")
    out.write_bytes(build())
    print(f"wrote {out} ({out.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
