import { describe, expect, it } from 'vitest'
import type { TextItem } from './pdf'
import { assemblePageSignals, assemblePageText, pdfParser } from './pdf'
import { splitParagraphs } from './util'

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

describe('assemblePageSignals', () => {
  it('returns one signal per paragraph, aligned with splitParagraphs', () => {
    const items = [item('First paragraph.', 100, 12), item('Second paragraph.', 70, 12)]
    const text = assemblePageText(items)
    const signals = assemblePageSignals(items)
    const paragraphs = splitParagraphs(text)
    expect(signals.length).toBe(paragraphs.length)
  })

  it('captures the max font size per paragraph', () => {
    const items = [item('Chapter 1', 100, 24), item('Body text.', 60, 12)]
    const signals = assemblePageSignals(items)
    expect(signals).toEqual([24, 12])
  })

  it('captures max font size across wrapped lines in the same paragraph', () => {
    const items = [item('Line one', 100, 12), item('line two', 88, 14)]
    const signals = assemblePageSignals(items)
    expect(signals).toEqual([14])
  })

  it('returns empty for no items', () => {
    expect(assemblePageSignals([])).toEqual([])
  })

  it('skips empty paragraph groups (no text)', () => {
    const items = [item('', 100, 24), item('Real text.', 60, 12)]
    const signals = assemblePageSignals(items)
    expect(signals).toEqual([12])
  })
})

describe('pdfParser', () => {
  it('matches by extension (case-insensitive) and by mime', () => {
    expect(pdfParser.matches(new File([], 'book.pdf', { type: 'application/pdf' }))).toBe(true)
    expect(pdfParser.matches(new File([], 'book.PDF', { type: '' }))).toBe(true)
    expect(pdfParser.matches(new File([], 'book.txt', { type: 'text/plain' }))).toBe(false)
  })
})
