import type { BookFormat } from '../../types'
import type { Parser } from './types'
import { extensionOf, splitParagraphs, titleFromFilename } from './util'

const TXT_EXTENSIONS = new Set(['txt'])

export const txtParser: Parser = {
  format: 'txt' satisfies BookFormat,
  matches(file) {
    return TXT_EXTENSIONS.has(extensionOf(file.name)) || file.type === 'text/plain'
  },
  async parse(file) {
    const text = await file.text()
    const title = titleFromFilename(file.name)
    const paragraphs = splitParagraphs(text)
    return { title, chapters: [{ title, paragraphs }] }
  },
}
