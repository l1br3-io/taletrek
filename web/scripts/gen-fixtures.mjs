#!/usr/bin/env node
import JSZip from 'jszip'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const OUT = '/tmp/opencode/taletrek-fixtures'

const CONTAINER_XML = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`

const OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>The Harbor</dc:title>
    <dc:identifier id="bookid">harbor-001</dc:identifier>
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
  <docTitle><text>The Harbor</text></docTitle>
  <navMap>
    <navPoint id="n1"><navLabel><text>Arrival</text></navLabel><content src="chapter1.xhtml"/></navPoint>
    <navPoint id="n2"><navLabel><text>Departure</text></navLabel><content src="chapter2.xhtml"/></navPoint>
  </navMap>
</ncx>`

function xhtml(title, body) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head>
<body>${body}</body></html>`
}

async function writeEpub() {
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip')
  zip.file('META-INF/container.xml', CONTAINER_XML)
  zip.file('OEBPS/content.opf', OPF)
  zip.file('OEBPS/toc.ncx', NCX)
  zip.file(
    'OEBPS/chapter1.xhtml',
    xhtml(
      'Arrival',
      '<h1>Arrival</h1><p>The boat nudged the dock at first light.</p><p>Mara stepped onto the wet planks and breathed the salt air.</p>',
    ),
  )
  zip.file(
    'OEBPS/chapter2.xhtml',
    xhtml(
      'Departure',
      '<h1>Departure</h1><p>By evening the harbor lights had vanished behind her.</p><p>The open sea stretched out, dark and patient.</p>',
    ),
  )
  const buf = await zip.generateAsync({ type: 'nodebuffer' })
  await writeFile(join(OUT, 'sample.epub'), buf)
}

function escapePdf(s) {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

function buildPdf(lines) {
  let content = 'BT\n/F1 24 Tf\n72 720 Td\n'
  for (const line of lines) {
    content += `(${escapePdf(line)}) Tj\n0 -36 Td\n`
  }
  content += 'ET'

  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]

  let pdf = '%PDF-1.4\n'
  const offsets = []
  for (let i = 0; i < objs.length; i++) {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`
  }
  const xrefStart = pdf.length
  const count = objs.length + 1
  pdf += `xref\n0 ${count}\n0000000000 65535 f \n`
  for (const off of offsets) {
    pdf += `${String(off).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`
  return Buffer.from(pdf, 'latin1')
}

async function writePdf() {
  const buf = buildPdf([
    'The Lighthouse',
    'A short PDF document for testing.',
    'It keeps watch over the cold dark sea.',
  ])
  await writeFile(join(OUT, 'sample.pdf'), buf)
}

async function writeTxt() {
  const text = `The Lighthouse

The keeper climbed the spiral stairs each evening.
The lamp woke slowly, throwing its beam across the water.

Ships out on the black sea turned toward the light,
glad of a fixed point in the moving dark.`
  await writeFile(join(OUT, 'sample.txt'), text, 'utf8')
}

await mkdir(OUT, { recursive: true })
await Promise.all([writeEpub(), writePdf(), writeTxt()])
console.log(`Fixtures written to ${OUT}`)
