import { describe, expect, it } from 'vitest'
import type { TextItem } from './pdf'
import { assemblePageText, pdfParser } from './pdf'

function item(str: string, y: number, size = 12): TextItem {
  return { str, transform: [size, 0, 0, size, 0, y], height: size }
}

describe('assemblePageText', () => {
  it('joins items on the same line with spaces', () => {
    const text = assemblePageText([item('Hello', 100), item('world', 100)])
    expect(text).toBe('Hello world')
  })

  it('treats a small vertical step as a line wrap within a paragraph', () => {
    const text = assemblePageText([item('Line one', 100), item('wrapped here.', 88)])
    expect(text).toBe('Line one\nwrapped here.')
  })

  it('inserts a paragraph break on a large vertical gap', () => {
    const text = assemblePageText([item('First paragraph.', 100), item('Second paragraph.', 70)])
    expect(text).toBe('First paragraph.\n\nSecond paragraph.')
  })

  it('handles multiple paragraphs and wrapped lines together', () => {
    const text = assemblePageText([
      item('Para one line a', 100),
      item('para one line b', 88),
      item('Para two', 60),
      item('para two b', 48),
    ])
    expect(text).toBe('Para one line a\npara one line b\n\nPara two\npara two b')
  })

  it('returns empty for no items', () => {
    expect(assemblePageText([])).toBe('')
  })
})

describe('pdfParser', () => {
  it('matches by extension (case-insensitive) and by mime', () => {
    expect(pdfParser.matches(new File([], 'book.pdf', { type: 'application/pdf' }))).toBe(true)
    expect(pdfParser.matches(new File([], 'book.PDF', { type: '' }))).toBe(true)
    expect(pdfParser.matches(new File([], 'book.txt', { type: 'text/plain' }))).toBe(false)
  })
})
