import type { BookFormat } from '../../types'
import type { ParsedChapter, Parser } from './types'
import { ParseError } from './types'
import { titleFromFilename } from './util'

if (
  typeof ReadableStream !== 'undefined' &&
  !(Symbol.asyncIterator in (ReadableStream.prototype as unknown as object))
) {
  ;(ReadableStream.prototype as unknown as Record<symbol, unknown>)[Symbol.asyncIterator] =
    async function* (this: ReadableStream) {
      const reader = this.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) return
          yield value
        }
      } finally {
        reader.releaseLock()
      }
    }
}

export interface TextItem {
  str: string
  transform: number[]
  height: number
}

/**
 * A paragraph with its vertical position. `y` is in PDF user space (origin at
 * the page's bottom-left, units = points) — the same coordinate system pdfjs
 * uses for outline destinations. Within a page, paragraphs are typically in
 * descending `y` order (top-of-page first), matching pdfjs's text-item stream.
 */
export interface PageParagraph {
  text: string
  y: number
}

/**
 * Minimal pdfjs type aliases. Imported dynamically inside `parse()` so the
 * parser stays worker-safe; these aliases exist only for inline typing of the
 * Tier 1 outline helper below.
 */
type PdfDocumentProxy = {
  getOutline(): Promise<
    Array<{
      title: string
      dest: string | Array<unknown> | null
      items: Array<unknown>
    }>
  >
  getDestination(id: string): Promise<Array<unknown> | null>
  getPageIndex(ref: unknown): Promise<number>
}

/**
 * Tier 1 outline entry — title + the resolved destination. `pageIndex` is the
 * 0-based page the heading lands on; `startY` is the Y coord (PDF user space)
 * of the heading on that page, or `null` when the dest carries no Y (e.g. a
 * bare `[pageRef]` or `[pageRef, left, zoom]` form). Used to split mid-page
 * chapter starts so navigation lands on the actual heading paragraph rather
 * than the first body paragraph on the page.
 */
export interface OutlineEntry {
  title: string
  pageIndex: number
  startY: number | null
}

/**
 * Group raw pdfjs text items on a single page into paragraphs, preserving the
 * Y coord of each paragraph's first line. Items are assumed to arrive in
 * reading order (top-of-page first → descending Y). The paragraph-break
 * threshold matches the prior `assemblePageText` heuristic: a vertical gap
 * larger than `1.5 × font height` starts a new paragraph; smaller gaps join
 * into the current paragraph with a space.
 */
export function groupItemsIntoParagraphs(items: readonly TextItem[]): PageParagraph[] {
  if (items.length === 0) return []
  const yOf = (it: TextItem): number => it.transform[5] ?? 0
  const hOf = (it: TextItem): number => Math.abs(it.transform[3] ?? 0) || it.height || 12

  const result: PageParagraph[] = []
  let buf = ''
  let bufY = yOf(items[0]!)
  let prevY = bufY
  let prevH = hOf(items[0]!)

  const flush = (): void => {
    const trimmed = buf.trim()
    if (trimmed) result.push({ text: trimmed, y: bufY })
    buf = ''
  }

  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (!item) continue
    if (i > 0) {
      const gap = prevY - yOf(item)
      const h = prevH || hOf(item)
      if (gap > h * 1.5) {
        flush()
        bufY = yOf(item)
      }
    }
    if (item.str) {
      if (buf && !buf.endsWith(' ') && !item.str.startsWith(' ')) buf += ' '
      buf += item.str
    }
    prevY = yOf(item)
    prevH = hOf(item)
  }
  flush()
  return result
}

/**
 * Tier 1: read the PDF's embedded bookmark tree (`/Outlines`) and resolve each
 * top-level entry to a page index + Y position. Returns null when absent, when
 * zero entries resolve, or when fewer than 2 resolve (a single-entry outline
 * gives no useful chapter boundaries).
 *
 * Nested entries (sub-bookmarks) are intentionally ignored — `ParsedChapter`
 * is a flat list. Future work could expose them via AI re-processing.
 *
 * Each `dest` is resolved defensively: a string is a named destination
 * (looked up via `getDestination`), an array is an explicit
 * `[pageRef, left, top, zoom]` tuple (any suffix may be truncated). Malformed
 * entries are skipped, not fatal — partial outlines still produce useful
 * splits.
 */
export async function extractOutline(doc: PdfDocumentProxy): Promise<OutlineEntry[] | null> {
  let outline: Awaited<ReturnType<PdfDocumentProxy['getOutline']>>
  try {
    outline = await doc.getOutline()
  } catch {
    return null
  }
  if (!outline || outline.length < 2) return null

  const entries: OutlineEntry[] = []
  for (const node of outline) {
    if (!node || typeof node.title !== 'string') continue
    const pos = await resolveDestPosition(doc, node.dest)
    if (!pos) continue
    entries.push({
      title: stripHtml(node.title).trim(),
      pageIndex: pos.pageIndex,
      startY: pos.startY,
    })
  }

  if (entries.length < 2) return null

  entries.sort((a, b) =>
    a.pageIndex !== b.pageIndex
      ? a.pageIndex - b.pageIndex
      : compareYDescending(a.startY, b.startY),
  )
  return entries
}

/**
 * Compare two `startY` values for same-page outline entries. PDF coords are
 * bottom-up, so a heading higher on the page (larger Y) sorts first. `null`
 * (whole-page dest) is treated as +∞ so it precedes any Y-bound entry on the
 * same page (i.e. a bare `[pageRef]` dest claims the whole page from its top).
 */
function compareYDescending(a: number | null, b: number | null): number {
  const ay = a ?? Number.POSITIVE_INFINITY
  const by = b ?? Number.POSITIVE_INFINITY
  return by - ay
}

/** Resolve a pdfjs outline `dest` to `{ pageIndex, startY }`, or null on failure. */
async function resolveDestPosition(
  doc: PdfDocumentProxy,
  dest: string | Array<unknown> | null,
): Promise<{ pageIndex: number; startY: number | null } | null> {
  if (!dest) return null
  let explicit: Array<unknown> | null = null
  if (typeof dest === 'string') {
    try {
      explicit = await doc.getDestination(dest)
    } catch {
      return null
    }
  } else {
    explicit = dest
  }
  if (!explicit || explicit.length === 0) return null
  const ref = explicit[0]
  if (ref == null) return null
  let pageIndex: number
  try {
    pageIndex = await doc.getPageIndex(ref)
  } catch {
    return null
  }
  if (pageIndex < 0) return null
  return { pageIndex, startY: extractTopFromDest(explicit) }
}

/**
 * Pull the `top` Y coord (PDF user space) out of an explicit dest array. The
 * array shape depends on the dest type at index 1 (a pdfjs Name object with a
 * `.name` field): `/XYZ` carries top at index 3, `/FitH` + `/FitBH` at index 2,
 * `/FitR` at index 5; the `/Fit` family + `/FitV` family have no top coord
 * (they fit a page dimension, not a position). Returns null when the type is
 * unknown, missing, or carries no top — callers fall back to whole-page
 * inclusion in that case.
 */
function extractTopFromDest(explicit: Array<unknown>): number | null {
  if (explicit.length < 2) return null
  const type = explicit[1]
  const typeName =
    typeof type === 'object' && type !== null && 'name' in type
      ? String((type as { name: unknown }).name)
      : null
  switch (typeName) {
    case 'XYZ':
      // [page, /XYZ, left, top, zoom?]
      return numericAt(explicit, 3)
    case 'FitH':
    case 'FitBH':
      // [page, /FitH, top]
      return numericAt(explicit, 2)
    case 'FitR':
      // [page, /FitR, left, bottom, right, top]
      return numericAt(explicit, 5)
    case 'Fit':
    case 'FitB':
    case 'FitV':
    case 'FitBV':
      // No top coord — these fit a page dimension rather than a position.
      return null
    default:
      return null
  }
}

function numericAt(arr: Array<unknown>, idx: number): number | null {
  const v = arr[idx]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** Strip simple HTML markup from outline titles (pdfjs returns `<b>`, `<i>` etc.). */
function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, '')
}

/**
 * Normalize text for heading comparison: lowercase, strip all whitespace and
 * punctuation. Lets "Chapter 5" match "CHAPTER 5." or "Chapter 5:" etc.
 */
function normalizeForCompare(s: string): string {
  return s.toLowerCase().replace(/[\s\p{P}]+/gu, '')
}

/**
 * Drop the leading body paragraph when it matches the chapter title. PDF
 * authors often write "Chapter 5" (or "CHAPTER FIVE") in the body AND bookmark
 * it — without this strip, the TTS would read the heading aloud as the first
 * paragraph of the chapter. Conservative: only exact normalized matches.
 */
function stripLeadingHeading(paragraphs: string[], chapterTitle: string): string[] {
  if (paragraphs.length === 0) return paragraphs
  const target = normalizeForCompare(chapterTitle)
  if (!target) return paragraphs
  return normalizeForCompare(paragraphs[0]!) === target ? paragraphs.slice(1) : paragraphs
}

/**
 * Group per-page paragraphs into chapters using Tier 1 outline destinations.
 * Uses both the page index AND the Y coord (when present) so that mid-page
 * chapter starts split accurately: paragraphs above the heading stay in the
 * previous chapter; paragraphs at or below go in the new chapter.
 *
 * Pages (or page-fractions) before the first outline entry become a
 * "Front Matter" chapter (or fold into chapter 1 when the first heading is at
 * the top of page 0). When the first body paragraph of a chapter textually
 * matches the chapter title, it is stripped (see {@link stripLeadingHeading}).
 */
export function groupPagesIntoChapters(
  outline: OutlineEntry[],
  pageParagraphs: PageParagraph[][],
  fallbackTitle: string,
): ParsedChapter[] {
  const total = pageParagraphs.length
  const chapters: ParsedChapter[] = []

  // Flatten all paragraphs with their page index, in document order.
  interface FlatPara {
    text: string
    y: number
    page: number
  }
  const flat: FlatPara[] = []
  for (let p = 0; p < total; p++) {
    for (const para of pageParagraphs[p] ?? []) {
      flat.push({ text: para.text, y: para.y, page: p })
    }
  }

  // Find the index in `flat` where a chapter begins: the first paragraph at or
  // after `fromIdx` that is on a page >= entry.pageIndex, AND (when startY is
  // set) is at or below the heading's Y on the start page. PDF coords are
  // bottom-up, so "at or below" means `y <= startY`. If no paragraph on the
  // start page satisfies the Y constraint (e.g. startY came from a noisy dest),
  // fall back to the first paragraph on the start page so we don't skip the
  // whole page and land on the next chapter's territory.
  const findCut = (entry: OutlineEntry, fromIdx: number): number => {
    let firstOnPage = -1
    for (let i = fromIdx; i < flat.length; i++) {
      const p = flat[i]!
      if (p.page < entry.pageIndex) continue
      if (p.page === entry.pageIndex && firstOnPage === -1) firstOnPage = i
      if (p.page !== entry.pageIndex) {
        // Moved past the start page without a Y match — fall back.
        return firstOnPage >= 0 ? firstOnPage : i
      }
      if (entry.startY != null && p.y > entry.startY) continue
      return i
    }
    return firstOnPage >= 0 ? firstOnPage : flat.length
  }

  const cuts: number[] = []
  let cursor = 0
  for (const entry of outline) {
    const cut = findCut(entry, cursor)
    cuts.push(cut)
    cursor = cut
  }

  // Front matter: paragraphs before the first chapter's cut. Skipped when the
  // first heading is at the very top of the document (cut === 0).
  if (cuts.length > 0 && cuts[0]! > 0) {
    const fmTexts = flat.slice(0, cuts[0]!).map((p) => p.text)
    if (fmTexts.length > 0) {
      chapters.push({
        title: fallbackTitle.trim() || 'Front Matter',
        paragraphs: fmTexts,
      })
    }
  }

  for (let i = 0; i < outline.length; i++) {
    const entry = outline[i]!
    const start = cuts[i]!
    const end = i + 1 < cuts.length ? cuts[i + 1]! : flat.length
    const bodyTexts = flat.slice(start, end).map((p) => p.text)
    const title = entry.title || `Chapter ${i + 1}`
    chapters.push({ title, paragraphs: stripLeadingHeading(bodyTexts, title) })
  }

  return chapters.length > 0
    ? chapters
    : [{ title: fallbackTitle, paragraphs: flat.map((p) => p.text) }]
}

export const pdfParser: Parser = {
  format: 'pdf' satisfies BookFormat,
  matches(file) {
    return file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf'
  },
  async parse(file) {
    const pdfjs = await import('pdfjs-dist')
    const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

    const data = await file.arrayBuffer()
    const doc = (await pdfjs.getDocument({ data, disableFontFace: true, useSystemFonts: false })
      .promise) as unknown as PdfDocumentProxy & {
      numPages: number
      getPage(n: number): Promise<{
        getTextContent(): Promise<{ items: Array<Record<string, unknown>> }>
        cleanup(): void
      }>
      getMetadata(): Promise<{ info: unknown }>
      cleanup(): Promise<void>
    }
    try {
      const meta = await doc.getMetadata()
      const info = meta.info as unknown as Record<string, unknown>
      const metaTitle = typeof info.Title === 'string' ? info.Title.trim() : ''
      const title = metaTitle || titleFromFilename(file.name)

      // Tier 1: try the embedded outline first. Authoritative when present.
      const outline = await extractOutline(doc)

      // Walk every page once, collecting paragraphs with their Y coords.
      const pageParagraphs: PageParagraph[][] = []
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i)
        const content = await page.getTextContent()
        const items = content.items.filter(hasStr).map(toTextItem)
        pageParagraphs.push(groupItemsIntoParagraphs(items))
        page.cleanup()
      }

      const totalParagraphCount = pageParagraphs.reduce((n, p) => n + p.length, 0)
      if (totalParagraphCount === 0) {
        throw new ParseError(
          `No text found in PDF (it may be a scanned image): ${file.name}`,
          'pdf',
        )
      }

      // Tier 1 hit: group pages into chapters by outline destinations,
      // splitting mid-page starts at the heading's Y coord.
      if (outline && outline.length >= 2) {
        return { title, chapters: groupPagesIntoChapters(outline, pageParagraphs, title) }
      }

      // No embedded outline → single-chapter output. The user can re-process
      // via AI from the library menu (useOutline.runWithAi).
      return {
        title,
        chapters: [{ title, paragraphs: pageParagraphs.flat().map((p) => p.text) }],
      }
    } finally {
      await doc.cleanup()
    }
  },
}

function hasStr(item: unknown): boolean {
  return typeof (item as { str?: unknown }).str === 'string'
}

function toTextItem(item: unknown): TextItem {
  const it = item as { str: string; transform: number[]; height: number }
  return { str: it.str, transform: it.transform, height: it.height }
}
