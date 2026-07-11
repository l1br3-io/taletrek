import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { parseFile } from './dispatcher'
import { epubParser } from './epub'
import { ParseError } from './types'

const CONTAINER_XML = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`

const OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>The Test Book</dc:title>
    <dc:identifier id="bookid">test-001</dc:identifier>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>`

const NCX = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <docTitle><text>The Test Book</text></docTitle>
  <navMap>
    <navPoint id="n1"><navLabel><text>Beginnings</text></navLabel><content src="chapter1.xhtml"/></navPoint>
    <navPoint id="n2"><navLabel><text>The Voyage</text></navLabel><content src="chapter2.xhtml"/></navPoint>
  </navMap>
</ncx>`

const CHAPTER1 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Ch1</title></head>
<body><h1>Beginnings</h1><p>First paragraph of chapter one.</p><p>Second paragraph here.</p></body></html>`

const CHAPTER2 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Ch2</title></head>
<body><h1>The Voyage</h1><p>The ship sailed at dawn.</p><ul><li>A sail</li><li>A mast</li></ul></body></html>`

async function makeEpub(
  files: Record<string, string> = {},
  opfPath = 'OEBPS/content.opf',
): Promise<File> {
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip')
  zip.file('META-INF/container.xml', CONTAINER_XML)
  zip.file(opfPath, OPF)
  zip.file('OEBPS/toc.ncx', NCX)
  zip.file('OEBPS/chapter1.xhtml', CHAPTER1)
  zip.file('OEBPS/chapter2.xhtml', CHAPTER2)
  for (const [name, content] of Object.entries(files)) zip.file(name, content)
  const buf = await zip.generateAsync({ type: 'arraybuffer' })
  return new File([buf], 'test.epub', { type: 'application/epub+zip' })
}

describe('epubParser', () => {
  it('matches by extension and mime', () => {
    expect(epubParser.matches(new File([], 'book.epub', { type: 'application/epub+zip' }))).toBe(
      true,
    )
    expect(epubParser.matches(new File([], 'book.EPUB', { type: '' }))).toBe(true)
    expect(epubParser.matches(new File([], 'book.pdf', { type: 'application/pdf' }))).toBe(false)
  })

  it('extracts title, chapters, and paragraph text', async () => {
    const result = await epubParser.parse(await makeEpub())
    expect(result.title).toBe('The Test Book')
    expect(result.chapters).toHaveLength(2)
    expect(result.chapters[0]?.title).toBe('Beginnings')
    expect(result.chapters[1]?.title).toBe('The Voyage')
    expect(result.chapters[0]?.paragraphs).toEqual([
      'Beginnings',
      'First paragraph of chapter one.',
      'Second paragraph here.',
    ])
  })

  it('extracts list items as separate paragraphs', async () => {
    const result = await epubParser.parse(await makeEpub())
    expect(result.chapters[1]?.paragraphs).toEqual([
      'The Voyage',
      'The ship sailed at dawn.',
      'A sail',
      'A mast',
    ])
  })

  it('throws ParseError when no readable text is found', async () => {
    const emptyOpf = OPF.replace(
      '</package>',
      '  <item id="empty" href="empty.xhtml" media-type="application/xhtml+xml"/>',
    )
      .replace('<item id="ch1"', '<!--')
      .replace('<itemref idref="ch2"/>', '-->')
    const zip = new JSZip()
    zip.file('mimetype', 'application/epub+zip')
    zip.file('META-INF/container.xml', CONTAINER_XML)
    zip.file('OEBPS/content.opf', emptyOpf)
    zip.file('OEBPS/empty.xhtml', '<html><body></body></html>')
    const buf = await zip.generateAsync({ type: 'arraybuffer' })
    await expect(epubParser.parse(new File([buf], 'empty.epub'))).rejects.toBeInstanceOf(ParseError)
  })

  it('falls back to filename when dc:title is absent', async () => {
    const opfNoTitle = OPF.replace('<dc:title>The Test Book</dc:title>', '')
    const file = await makeEpub({ 'OEBPS/content.opf': opfNoTitle })
    const result = await epubParser.parse(file)
    expect(result.title).toBe('test')
  })
})

describe('parseFile dispatcher (epub)', () => {
  it('routes .epub to the epub parser', async () => {
    const result = await parseFile(await makeEpub())
    expect(result.chapters).toHaveLength(2)
    expect(result.title).toBe('The Test Book')
  })
})
