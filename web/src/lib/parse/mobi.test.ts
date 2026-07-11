import { describe, expect, it } from 'vitest'
import { parseFile } from './dispatcher'
import { decompressPalmdoc, mobiParser } from './mobi'
import { ParseError } from './types'

interface Record0Opts {
  textLength: number
  compression: number
  encryption: number
  mobiType: number
  fileVersion: number
  extraDataFlags: number
  encoding: number
  fullName: string
}

function buildRecord0(p: Record0Opts): Uint8Array {
  const name = new TextEncoder().encode(p.fullName)
  const buf = new Uint8Array(248 + name.length)
  const dv = new DataView(buf.buffer)
  dv.setUint16(0, p.compression)
  dv.setUint32(4, p.textLength)
  dv.setUint16(8, 1)
  dv.setUint16(10, 4096)
  dv.setUint16(12, p.encryption)
  writeAscii(buf, 16, 'MOBI')
  dv.setUint32(20, 232)
  dv.setUint32(24, p.mobiType)
  dv.setUint32(28, p.encoding)
  dv.setUint32(36, p.fileVersion)
  dv.setUint32(84, 248)
  dv.setUint32(88, name.length)
  dv.setUint32(108, 0xffffffff)
  dv.setUint32(240, p.extraDataFlags)
  buf.set(name, 248)
  return buf
}

function buildPdb(rec0: Uint8Array, textRecord: Uint8Array, name = 'Test Book'): ArrayBuffer {
  const numRecords = 2
  const rec0Offset = 78 + numRecords * 8
  const rec1Offset = rec0Offset + rec0.length
  const buf = new ArrayBuffer(rec1Offset + textRecord.length)
  const u8 = new Uint8Array(buf)
  const dv = new DataView(buf)
  writeAscii(u8, 0, name.slice(0, 31))
  writeAscii(u8, 60, 'BOOK')
  writeAscii(u8, 64, 'MOBI')
  dv.setUint16(76, numRecords)
  dv.setUint32(78, rec0Offset)
  dv.setUint32(86, rec1Offset)
  u8.set(rec0, rec0Offset)
  u8.set(textRecord, rec1Offset)
  return buf
}

function writeAscii(buf: Uint8Array, offset: number, s: string): void {
  for (let i = 0; i < s.length; i++) buf[offset + i] = s.charCodeAt(i) & 0xff
}

function mobiFile(html: string, overrides: Partial<Record0Opts> = {}, pdbName = 'Test Book'): File {
  const htmlBytes = new TextEncoder().encode(html)
  const rec0 = buildRecord0({
    textLength: htmlBytes.length,
    compression: 1,
    encryption: 0,
    mobiType: 2,
    fileVersion: 6,
    extraDataFlags: 0,
    encoding: 65001,
    fullName: 'Test Book',
    ...overrides,
  })
  const pdb = buildPdb(rec0, htmlBytes, pdbName)
  return new File([pdb], 'book.mobi')
}

const SAMPLE_HTML =
  '<html><body><h1>Chapter One</h1><p>Hello world.</p><p>Second paragraph.</p></body></html>'

describe('mobiParser', () => {
  it('extracts the title and paragraphs from an uncompressed MOBI', async () => {
    const result = await mobiParser.parse(mobiFile(SAMPLE_HTML))
    expect(result.title).toBe('Test Book')
    expect(result.chapters).toHaveLength(1)
    expect(result.chapters[0]?.title).toBe('Test Book')
    expect(result.chapters[0]?.paragraphs).toEqual([
      'Chapter One',
      'Hello world.',
      'Second paragraph.',
    ])
  })

  it('decodes HTML entities and collapses whitespace', async () => {
    const result = await mobiParser.parse(
      mobiFile('<p>Cats &amp; dogs&nbsp;&mdash; the &quot;best&quot;.</p>'),
    )
    expect(result.chapters[0]?.paragraphs).toEqual(['Cats & dogs\u00a0— the "best".'])
  })

  it('treats <mbp:pagebreak> and block closings as paragraph breaks', async () => {
    const result = await mobiParser.parse(
      mobiFile('<p>Page one</p><mbp:pagebreak/><p>Page two</p>'),
    )
    expect(result.chapters[0]?.paragraphs).toEqual(['Page one', 'Page two'])
  })

  it('works through the dispatcher by extension', async () => {
    const result = await parseFile(mobiFile('<p>Dispatched.</p>'))
    expect(result.chapters[0]?.paragraphs).toEqual(['Dispatched.'])
  })

  it('matches by extension (case-insensitive) and mime', () => {
    expect(mobiParser.matches(new File([], 'a.mobi'))).toBe(true)
    expect(mobiParser.matches(new File([], 'a.MOBI'))).toBe(true)
    expect(mobiParser.matches(new File([], 'a.azw'))).toBe(true)
    expect(mobiParser.matches(new File([], 'a', { type: 'application/x-mobipocket-ebook' }))).toBe(
      true,
    )
    expect(mobiParser.matches(new File([], 'a.epub'))).toBe(false)
  })

  it('rejects encrypted (DRM) files with a friendly ParseError', async () => {
    await expect(mobiParser.parse(mobiFile(SAMPLE_HTML, { encryption: 1 }))).rejects.toThrow(
      /encrypted/i,
    )
  })

  it('rejects HUFF/CDIC compression with a friendly ParseError', async () => {
    await expect(mobiParser.parse(mobiFile(SAMPLE_HTML, { compression: 17480 }))).rejects.toThrow(
      /HUFF\/CDIC/i,
    )
  })

  it('rejects KF8 (mobi type 248) with a friendly ParseError', async () => {
    await expect(mobiParser.parse(mobiFile(SAMPLE_HTML, { mobiType: 248 }))).rejects.toThrow(/KF8/i)
  })

  it('rejects malformed (too-small) input', async () => {
    await expect(
      mobiParser.parse(new File([new ArrayBuffer(16)], 'broken.mobi')),
    ).rejects.toBeInstanceOf(ParseError)
  })
})

describe('decompressPalmdoc', () => {
  function dec(bytes: number[]): string {
    return new TextDecoder('latin1').decode(decompressPalmdoc(new Uint8Array(bytes)))
  }

  it('passes through literal bytes in the 0x09–0x7F range', () => {
    expect(dec([0x41, 0x42, 0x43])).toBe('ABC')
  })

  it('emits a literal null for 0x00', () => {
    expect(Array.from(decompressPalmdoc(new Uint8Array([0x00])))).toEqual([0])
  })

  it('copies a run of literals for 0x01–0x08', () => {
    expect(dec([0x02, 0x58, 0x59])).toBe('XY')
  })

  it('expands 0xC0–0xFF into space + (byte ^ 0x80)', () => {
    expect(dec([0xc0])).toBe(' @')
    expect(dec([0xe1])).toBe(' a')
  })

  it('decodes a back-reference (distance 1, length 3) into a run', () => {
    // literal 'A', then pair 0x80 0x00 → distance 1, length 3 → 'AAAA'
    expect(Array.from(decompressPalmdoc(new Uint8Array([0x41, 0x80, 0x00])))).toEqual([
      0x41, 0x41, 0x41, 0x41,
    ])
  })

  it('round-trips a full paragraph through the parser using compression=2', async () => {
    // Every byte of the HTML below falls in the 0x09–0x7F literal range, so a
    // "compressed" record equal to the raw bytes decodes to itself — this
    // exercises the PalmDOC dispatch path end-to-end.
    const html = '<p>Compressed path works.</p>'
    const result = await mobiParser.parse(mobiFile(html, { compression: 2 }))
    expect(result.chapters[0]?.paragraphs).toEqual(['Compressed path works.'])
  })
})
