import type { BookFormat } from '../../types'
import type { ParsedChapter, Parser } from './types'
import { ParseError } from './types'
import { splitParagraphs, titleFromFilename } from './util'

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

export function assemblePageText(items: readonly TextItem[]): string {
  if (items.length === 0) return ''
  const yOf = (it: TextItem): number => it.transform[5] ?? 0
  const hOf = (it: TextItem): number => Math.abs(it.transform[3] ?? 0) || it.height || 12

  const first = items[0]
  if (!first) return ''
  let out = first.str
  let prevY = yOf(first)
  let prevH = hOf(first)

  for (let i = 1; i < items.length; i++) {
    const item = items[i]
    if (!item) continue
    const gap = prevY - yOf(item)
    const h = prevH || hOf(item)
    if (gap > h * 1.5) out += '\n\n'
    else if (gap > 0.5) out += '\n'
    if (item.str) {
      if (!out.endsWith('\n') && !out.endsWith(' ') && !item.str.startsWith(' ')) out += ' '
      out += item.str
    }
    prevY = yOf(item)
    prevH = hOf(item)
  }
  return out
}

/**
 * Compute the max font size for each paragraph on a page. Mirrors the
 * paragraph-break logic of {@link assemblePageText} (gap > h * 1.5 = paragraph
 * boundary) so the result aligns 1:1 with `splitParagraphs(assemblePageText(items))`.
 * Empty paragraph groups (no text) are skipped to match `splitParagraphs`'s
 * `.filter(Boolean)` behavior.
 */
export function assemblePageSignals(items: readonly TextItem[]): number[] {
  if (items.length === 0) return []
  const yOf = (it: TextItem): number => it.transform[5] ?? 0
  const hOf = (it: TextItem): number => Math.abs(it.transform[3] ?? 0) || it.height || 12

  const first = items[0]
  if (!first) return []

  const signals: number[] = []
  let currentMax = hOf(first)
  let currentHasText = first.str.length > 0
  let prevY = yOf(first)
  let prevH = hOf(first)

  for (let i = 1; i < items.length; i++) {
    const item = items[i]
    if (!item) continue
    const gap = prevY - yOf(item)
    const h = prevH || hOf(item)
    if (gap > h * 1.5) {
      if (currentHasText) signals.push(currentMax)
      currentMax = 0
      currentHasText = false
    }
    if (item.str) currentHasText = true
    currentMax = Math.max(currentMax, hOf(item))
    prevY = yOf(item)
    prevH = h
  }
  if (currentHasText) signals.push(currentMax)
  return signals
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
    const doc = await pdfjs.getDocument({ data, disableFontFace: true, useSystemFonts: false })
      .promise
    try {
      const meta = await doc.getMetadata()
      const info = meta.info as unknown as Record<string, unknown>
      const metaTitle = typeof info.Title === 'string' ? info.Title.trim() : ''
      const title = metaTitle || titleFromFilename(file.name)

      const paragraphs: string[] = []
      const headingSignals: number[] = []
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i)
        const content = await page.getTextContent()
        const items = content.items.filter(hasStr).map(toTextItem)
        const text = assemblePageText(items)
        const pageSignals = assemblePageSignals(items)
        paragraphs.push(...splitParagraphs(text))
        headingSignals.push(...pageSignals)
        page.cleanup()
      }

      if (paragraphs.length === 0) {
        throw new ParseError(
          `No text found in PDF (it may be a scanned image): ${file.name}`,
          'pdf',
        )
      }

      const chapters: ParsedChapter[] = [
        {
          title,
          paragraphs,
          headingSignals: headingSignals.length === paragraphs.length ? headingSignals : undefined,
        },
      ]
      return { title, chapters }
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
