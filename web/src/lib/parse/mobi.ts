import type { BookFormat } from '../../types'
import type { ParsedChapter, Parser } from './types'
import { ParseError } from './types'
import { extensionOf, splitParagraphs, titleFromFilename } from './util'

const MOBI_EXTENSIONS = new Set(['mobi', 'azw', 'prc'])
const MOBI_MIME_TYPES = new Set([
  'application/x-mobipocket-ebook',
  'application/x-mobi',
  'application/vnd.amazon.ebook',
])

const COMPRESSION_NONE = 1
const COMPRESSION_PALMDOC = 2
const COMPRESSION_HUFFCDIC = 17480

const PDB_HEADER_LEN = 78
const RECORD_INFO_LEN = 8

/**
 * Decode one PalmDOC LZ77 block (≤4096 bytes uncompressed). Blocks are
 * independent — no state carries across the boundary. Algorithm per the
 * MobileRead PalmDOC spec.
 */
export function decompressPalmdoc(input: Uint8Array): Uint8Array {
  const out: number[] = []
  let i = 0
  const n = input.length
  while (i < n) {
    const c = input[i] ?? 0
    i += 1
    if (c === 0x00) {
      out.push(0)
    } else if (c <= 0x08) {
      for (let k = 0; k < c && i < n; k++, i++) out.push(input[i] ?? 0)
    } else if (c <= 0x7f) {
      out.push(c)
    } else if (c <= 0xbf) {
      if (i >= n) break
      const c2 = input[i] ?? 0
      i += 1
      const pair = ((c & 0x3f) << 8) | c2
      const length = (pair & 0x07) + 3
      const distance = (pair >> 3) + 1
      const start = out.length - distance
      if (start < 0) break
      for (let k = 0; k < length; k++) out.push(out[start + k] ?? 0)
    } else {
      out.push(0x20, c ^ 0x80)
    }
  }
  return new Uint8Array(out)
}

export const mobiParser: Parser = {
  format: 'mobi' satisfies BookFormat,
  matches(file) {
    return MOBI_EXTENSIONS.has(extensionOf(file.name)) || MOBI_MIME_TYPES.has(file.type)
  },
  async parse(file) {
    const data = new Uint8Array(await file.arrayBuffer())
    const offsets = readRecordOffsets(data)
    const rec0 = recordBytes(data, offsets, 0)
    const { palmDoc, mobi, fullName } = parseRecord0(rec0)

    if (palmDoc.encryption !== 0) {
      throw new ParseError(
        `Cannot read encrypted/DRM-protected MOBI: ${file.name}. Convert it to EPUB instead.`,
        'mobi',
      )
    }
    if (palmDoc.compression === COMPRESSION_HUFFCDIC) {
      throw new ParseError(
        `MOBI uses HUFF/CDIC compression (unsupported): ${file.name}. Convert it to EPUB instead.`,
        'mobi',
      )
    }
    if (palmDoc.compression !== COMPRESSION_NONE && palmDoc.compression !== COMPRESSION_PALMDOC) {
      throw new ParseError(
        `Unsupported MOBI compression (${palmDoc.compression}): ${file.name}`,
        'mobi',
      )
    }
    if (mobi.present && (mobi.mobiType === 248 || mobi.fileVersion >= 8)) {
      throw new ParseError(
        `KF8/AZW3 format is unsupported: ${file.name}. Convert it to EPUB instead.`,
        'mobi',
      )
    }

    const flags = mobi.present ? mobi.extraDataFlags : 0
    const encoding = mobi.present && mobi.encoding === 1252 ? 'windows-1252' : 'utf-8'
    const recordCount = Math.min(palmDoc.recordCount, offsets.length - 1)
    const parts: Uint8Array[] = []
    let total = 0
    for (let r = 1; r <= recordCount && total < palmDoc.textLength; r++) {
      const raw = stripTrailingEntries(recordBytes(data, offsets, r), flags)
      const decoded = palmDoc.compression === COMPRESSION_PALMDOC ? decompressPalmdoc(raw) : raw
      parts.push(decoded)
      total += decoded.length
    }
    const fullBytes = concatBytes(parts, palmDoc.textLength)
    const text = new TextDecoder(encoding, { fatal: false }).decode(fullBytes)
    const paragraphs = htmlToParagraphs(text)
    if (paragraphs.length === 0) {
      throw new ParseError(`No readable text found in MOBI: ${file.name}`, 'mobi')
    }

    const title = (fullName || pdbName(data)).trim() || titleFromFilename(file.name)
    const chapters: ParsedChapter[] = [{ title, paragraphs }]
    return { title, chapters }
  },
}

interface PalmDocHeader {
  compression: number
  textLength: number
  recordCount: number
  recordSize: number
  encryption: number
}

interface MobiHeader {
  present: boolean
  mobiType: number
  encoding: number
  fileVersion: number
  fullNameOffset: number
  fullNameLength: number
  extraDataFlags: number
}

function readRecordOffsets(data: Uint8Array): number[] {
  if (data.byteLength < PDB_HEADER_LEN) {
    throw new ParseError('Invalid MOBI: file too small for a PDB header', 'mobi')
  }
  const dv = view(data)
  const numRecords = dv.getUint16(76)
  if (numRecords < 1) {
    throw new ParseError('Invalid MOBI: PDB record count is zero', 'mobi')
  }
  const infoEnd = PDB_HEADER_LEN + numRecords * RECORD_INFO_LEN
  if (infoEnd > data.byteLength) {
    throw new ParseError('Invalid MOBI: truncated PDB record-info table', 'mobi')
  }
  const offsets: number[] = []
  for (let p = PDB_HEADER_LEN; p < infoEnd; p += RECORD_INFO_LEN) {
    offsets.push(dv.getUint32(p))
  }
  return offsets
}

function recordBytes(data: Uint8Array, offsets: number[], index: number): Uint8Array {
  const start = offsets[index]
  if (start === undefined || start < 0 || start >= data.byteLength) {
    throw new ParseError(`Invalid MOBI: missing record ${index}`, 'mobi')
  }
  const next = offsets[index + 1]
  const end = next !== undefined && next <= data.byteLength ? next : data.byteLength
  return data.subarray(start, end)
}

function parseRecord0(rec0: Uint8Array): {
  palmDoc: PalmDocHeader
  mobi: MobiHeader
  fullName: string
} {
  if (rec0.byteLength < 16) {
    throw new ParseError('Invalid MOBI: record 0 too small for PalmDOC header', 'mobi')
  }
  const dv = view(rec0)
  const palmDoc: PalmDocHeader = {
    compression: dv.getUint16(0),
    textLength: dv.getUint32(4),
    recordCount: dv.getUint16(8),
    recordSize: dv.getUint16(10),
    encryption: dv.getUint16(12),
  }

  const mobi: MobiHeader = {
    present: false,
    mobiType: 0,
    encoding: 65001,
    fileVersion: 6,
    fullNameOffset: 0,
    fullNameLength: 0,
    extraDataFlags: 0,
  }
  let fullName = ''
  if (rec0.byteLength >= 244 && readAscii(rec0, 16, 4) === 'MOBI') {
    mobi.present = true
    const headerLength = dv.getUint32(20)
    mobi.mobiType = dv.getUint32(24)
    mobi.encoding = dv.getUint32(28)
    mobi.fileVersion = dv.getUint32(36)
    mobi.fullNameOffset = dv.getUint32(84)
    mobi.fullNameLength = dv.getUint32(88)
    mobi.extraDataFlags = headerLength >= 228 ? dv.getUint32(240) : 0
    const fno = mobi.fullNameOffset
    const fnl = mobi.fullNameLength
    if (fnl > 0 && fno + fnl <= rec0.byteLength) {
      fullName = new TextDecoder('utf-8', { fatal: false }).decode(rec0.subarray(fno, fno + fnl))
    }
  }
  return { palmDoc, mobi, fullName }
}

/**
 * Strip trailing-entry bytes appended to each text record per the MOBI header's
 * `extraDataFlags`. Bit 0 (multibyte overlap) is the common case; higher bits
 * (TBS indexing, uncrossable breaks) are stripped best-effort via a backward
 * varint size.
 */
function stripTrailingEntries(rec: Uint8Array, flags: number): Uint8Array {
  if (flags === 0) return rec
  let end = rec.length
  for (let bit = 15; bit >= 0 && end > 0; bit--) {
    if ((flags & (1 << bit)) === 0) continue
    const entrySize =
      bit === 0 ? ((rec[end - 1] ?? 0) & 0x03) + 1 : readBackwardVarintSize(rec, end)
    if (entrySize <= 0 || entrySize > end) break
    end -= entrySize
  }
  return rec.subarray(0, Math.max(0, end))
}

function readBackwardVarintSize(rec: Uint8Array, end: number): number {
  let val = 0
  let shift = 0
  for (let i = end - 1; i >= end - 4 && i >= 0; i--) {
    const b = rec[i] ?? 0
    val |= (b & 0x7f) << shift
    shift += 7
    if (b & 0x80) return val
  }
  return 0
}

const BLOCK_CLOSE_RE = /<\/(p|div|h[1-6]|li|blockquote|tr|td|th|section|article|header|footer)>/gi

function htmlToParagraphs(html: string): string[] {
  const withBreaks = html
    .replace(/<mbp:pagebreak\b[^>]*>/gi, '\n\n')
    .replace(BLOCK_CLOSE_RE, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
  return splitParagraphs(decodeEntities(withBreaks))
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  mdash: '\u2014',
  ndash: '\u2013',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
  hellip: '\u2026',
  deg: '\u00b0',
  bull: '\u2022',
}

function decodeEntities(s: string): string {
  return s.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body: string) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X'
      const code = isHex ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m
    }
    return NAMED_ENTITIES[body] ?? m
  })
}

function concatBytes(parts: Uint8Array[], maxLen: number): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0)
  const len = Math.min(total, maxLen)
  const out = new Uint8Array(len)
  let o = 0
  for (const p of parts) {
    if (o >= len) break
    const n = Math.min(p.length, len - o)
    out.set(p.subarray(0, n), o)
    o += n
  }
  return out
}

function pdbName(data: Uint8Array): string {
  const slice = data.subarray(0, Math.min(32, data.byteLength))
  let end = slice.length
  for (let i = 0; i < slice.length; i++) {
    if (slice[i] === 0) {
      end = i
      break
    }
  }
  return new TextDecoder('latin1').decode(slice.subarray(0, end)).trim()
}

function view(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength)
}

function readAscii(data: Uint8Array, offset: number, length: number): string {
  let s = ''
  for (let i = 0; i < length; i++) s += String.fromCodePoint(data[offset + i] ?? 0)
  return s
}
