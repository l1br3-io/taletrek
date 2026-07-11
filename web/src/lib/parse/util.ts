import type { BookFormat } from '../../types'

export function titleFromFilename(name: string): string {
  const base = name.split('/').pop() ?? name
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  return stem.trim() || 'Untitled'
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

const FORMAT_BY_EXTENSION: Record<string, BookFormat> = {
  txt: 'txt',
  epub: 'epub',
  pdf: 'pdf',
}

export function formatForFile(name: string): BookFormat | undefined {
  return FORMAT_BY_EXTENSION[extensionOf(name)]
}

export function splitParagraphs(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split(/\n{2,}/)
    .map((block) =>
      block
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .join(' '),
    )
    .filter((paragraph) => paragraph.length > 0)
}
