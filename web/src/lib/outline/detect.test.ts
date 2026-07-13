import { describe, expect, it } from 'vitest'
import type { ParsedChapter } from '../parse/types'
import { detectOutline, isHeading } from './detect'

function flat(paragraphs: string[], title = 'Test Book', signals?: number[]): ParsedChapter[] {
  return [{ title, paragraphs, headingSignals: signals }]
}

describe('isHeading', () => {
  it('matches "Chapter" with a number', () => {
    expect(isHeading('Chapter 1')).toBe(true)
    expect(isHeading('Chapter 12')).toBe(true)
    expect(isHeading('chapter 3')).toBe(true)
    expect(isHeading('CHAPTER 7')).toBe(true)
  })

  it('matches "Chapter" with a Roman numeral', () => {
    expect(isHeading('Chapter IV')).toBe(true)
    expect(isHeading('Chapter XII')).toBe(true)
  })

  it('matches "Chapter" with a title after a separator', () => {
    expect(isHeading('Chapter 1: The Beginning')).toBe(true)
    expect(isHeading('Chapter 3 - A New Hope')).toBe(true)
    expect(isHeading('Chapter 5. The Party')).toBe(true)
  })

  it('matches Part / Book / Section / Prologue / Epilogue / Interlude', () => {
    expect(isHeading('Part One')).toBe(true)
    expect(isHeading('PART II')).toBe(true)
    expect(isHeading('Book 3')).toBe(true)
    expect(isHeading('Section 1')).toBe(true)
    expect(isHeading('Prologue')).toBe(true)
    expect(isHeading('Epilogue')).toBe(true)
    expect(isHeading('Interlude')).toBe(true)
    expect(isHeading('Prologue: The Fall')).toBe(true)
  })

  it('matches short all-caps lines', () => {
    expect(isHeading('THE BEGINNING')).toBe(true)
    expect(isHeading('A NEW HOPE')).toBe(true)
    expect(isHeading('THE OLD MAN')).toBe(true)
  })

  it('rejects all-caps lines ending with sentence punctuation', () => {
    expect(isHeading('THE END.')).toBe(false)
    expect(isHeading('STOP!')).toBe(false)
  })

  it('rejects all-caps lines that are too long', () => {
    expect(isHeading('A'.repeat(61))).toBe(false)
  })

  it('rejects all-caps lines with fewer than 3 letters', () => {
    expect(isHeading('HI')).toBe(false)
    expect(isHeading('1 2 3')).toBe(false)
  })

  it('matches numeric section patterns', () => {
    expect(isHeading('1. Introduction')).toBe(true)
    expect(isHeading('1.1 Overview')).toBe(true)
    expect(isHeading('2.3.4 Details')).toBe(true)
    expect(isHeading('A. Methods')).toBe(true)
    expect(isHeading('B. Results')).toBe(true)
    expect(isHeading('§1 Legal Framework')).toBe(true)
  })

  it('rejects numeric patterns in long body text', () => {
    expect(isHeading('1. The quick brown fox jumps over the lazy dog and then runs away.')).toBe(
      false,
    )
  })

  it('rejects numeric patterns ending with sentence punctuation', () => {
    expect(isHeading('1. This is a sentence.')).toBe(false)
  })

  it('uses font-size signal to detect headings', () => {
    const median = 12
    expect(isHeading('A Storm Comes', 18, median)).toBe(true)
    expect(isHeading('Normal body text here.', 12, median)).toBe(false)
    expect(isHeading('Slightly larger.', 15, median)).toBe(true)
  })

  it('ignores font-size signal when median is 0', () => {
    expect(isHeading('Normal text', 24, 0)).toBe(false)
  })

  it('rejects empty strings', () => {
    expect(isHeading('')).toBe(false)
    expect(isHeading('   ')).toBe(false)
  })
})

describe('detectOutline — Level 1 (chapter boundaries)', () => {
  it('splits a flat chapter at "Chapter N" headings', () => {
    const input = flat([
      'Chapter 1',
      'It was the best of times.',
      'It was the worst of times.',
      'Chapter 2',
      'Years later, nothing changed.',
      'Chapter 3',
      'The end.',
    ])
    const result = detectOutline(input)
    expect(result.detected).toBe(true)
    expect(result.chapters).toHaveLength(3)
    expect(result.chapters[0]?.title).toBe('Chapter 1')
    expect(result.chapters[0]?.paragraphs).toEqual([
      'It was the best of times.',
      'It was the worst of times.',
    ])
    expect(result.chapters[1]?.title).toBe('Chapter 2')
    expect(result.chapters[1]?.paragraphs).toEqual(['Years later, nothing changed.'])
    expect(result.chapters[2]?.title).toBe('Chapter 3')
    expect(result.chapters[2]?.paragraphs).toEqual(['The end.'])
  })

  it('includes front matter as the first chapter', () => {
    const input = flat(['By Jane Doe', 'Copyright 2023', 'Chapter 1', 'The story begins.'])
    const result = detectOutline(input)
    expect(result.detected).toBe(true)
    expect(result.chapters).toHaveLength(2)
    expect(result.chapters[0]?.title).toBe('Test Book')
    expect(result.chapters[0]?.paragraphs).toEqual(['By Jane Doe', 'Copyright 2023'])
    expect(result.chapters[1]?.title).toBe('Chapter 1')
  })

  it('uses "Front Matter" when the original title is empty', () => {
    const input = [{ title: '', paragraphs: ['By Jane Doe', 'Chapter 1', 'Body text.'] }]
    const result = detectOutline(input)
    expect(result.chapters[0]?.title).toBe('Front Matter')
  })

  it('does not create a front-matter chapter when the first paragraph is a heading', () => {
    const input = flat(['Chapter 1', 'Body.'])
    const result = detectOutline(input)
    expect(result.detected).toBe(true)
    expect(result.chapters).toHaveLength(1)
    expect(result.chapters[0]?.title).toBe('Chapter 1')
    expect(result.chapters[0]?.paragraphs).toEqual(['Body.'])
  })

  it('returns input unchanged when no headings are found', () => {
    const input = flat([
      'It was a dark and stormy night.',
      'The rain fell in torrents.',
      'A dog barked in the distance.',
    ])
    const result = detectOutline(input)
    expect(result.detected).toBe(false)
    expect(result.chapters).toBe(input)
    expect(result.headings).toEqual([])
  })

  it('returns input unchanged when the input already has multiple chapters', () => {
    const input: ParsedChapter[] = [
      { title: 'Chapter 1', paragraphs: ['Body 1.'] },
      { title: 'Chapter 2', paragraphs: ['Body 2.'] },
    ]
    const result = detectOutline(input)
    expect(result.detected).toBe(false)
    expect(result.chapters).toBe(input)
  })

  it('handles "Chapter N: Title" headings preserving the full heading as title', () => {
    const input = flat([
      'Chapter 1: The Beginning',
      'In the beginning.',
      'Chapter 2: The End',
      'It was over.',
    ])
    const result = detectOutline(input)
    expect(result.chapters[0]?.title).toBe('Chapter 1: The Beginning')
    expect(result.chapters[1]?.title).toBe('Chapter 2: The End')
  })

  it('handles Roman numeral chapters', () => {
    const input = flat(['Chapter I', 'First.', 'Chapter II', 'Second.', 'Chapter III', 'Third.'])
    const result = detectOutline(input)
    expect(result.chapters).toHaveLength(3)
    expect(result.chapters[0]?.title).toBe('Chapter I')
    expect(result.chapters[2]?.title).toBe('Chapter III')
  })

  it('produces an empty body when two headings are adjacent', () => {
    const input = flat(['Chapter 1', 'Chapter 2', 'Body.'])
    const result = detectOutline(input)
    expect(result.chapters).toHaveLength(2)
    expect(result.chapters[0]?.title).toBe('Chapter 1')
    expect(result.chapters[0]?.paragraphs).toEqual([])
    expect(result.chapters[1]?.title).toBe('Chapter 2')
    expect(result.chapters[1]?.paragraphs).toEqual(['Body.'])
  })
})

describe('detectOutline — Level 2 (sub-headings)', () => {
  it('collects all-caps sub-headings within chapters', () => {
    const input = flat([
      'Chapter 1',
      'Intro paragraph.',
      'THE STORM',
      'It rained hard.',
      'THE CALM',
      'Then it stopped.',
      'Chapter 2',
      'New chapter body.',
    ])
    const result = detectOutline(input)
    expect(result.detected).toBe(true)
    expect(result.chapters).toHaveLength(2)
    expect(result.headings[0]).toEqual([
      { paragraphIndex: 1, title: 'THE STORM' },
      { paragraphIndex: 3, title: 'THE CALM' },
    ])
    expect(result.headings[1]).toEqual([])
  })

  it('collects numeric section sub-headings within chapters', () => {
    const input = flat([
      'Chapter 1',
      'Intro.',
      '1. First Steps',
      'We walked.',
      '2. The Forest',
      'Trees everywhere.',
    ])
    const result = detectOutline(input)
    expect(result.headings[0]).toEqual([
      { paragraphIndex: 1, title: '1. First Steps' },
      { paragraphIndex: 3, title: '2. The Forest' },
    ])
  })

  it('keeps Level 2 heading paragraphs in the chapter body', () => {
    const input = flat(['Chapter 1', 'Intro.', 'THE STORM', 'It rained.'])
    const result = detectOutline(input)
    expect(result.chapters[0]?.paragraphs).toEqual(['Intro.', 'THE STORM', 'It rained.'])
    expect(result.headings[0]?.[0]?.paragraphIndex).toBe(1)
  })

  it('returns Level 2 headings when no Level 1 headings exist', () => {
    const input = flat([
      'Intro paragraph.',
      'THE STORM',
      'It rained hard.',
      'THE CALM',
      'Then it stopped.',
    ])
    const result = detectOutline(input)
    expect(result.detected).toBe(true)
    expect(result.chapters).toBe(input)
    expect(result.headings).toHaveLength(1)
    expect(result.headings[0]).toEqual([
      { paragraphIndex: 1, title: 'THE STORM' },
      { paragraphIndex: 3, title: 'THE CALM' },
    ])
  })

  it('computes paragraphIndex relative to chapter body (not original flat index)', () => {
    const input = flat(['Front matter.', 'Chapter 1', 'Body intro.', 'SUB_HEADING', 'More body.'])
    const result = detectOutline(input)
    expect(result.chapters[1]?.paragraphs).toEqual(['Body intro.', 'SUB_HEADING', 'More body.'])
    expect(result.headings[1]).toEqual([{ paragraphIndex: 1, title: 'SUB_HEADING' }])
  })
})

describe('detectOutline — font-size signals', () => {
  it('uses font-size to detect Level 1 chapter boundaries', () => {
    const signals = [24, 12, 12, 24, 12, 12]
    const input = flat(
      [
        'A Hero Appears',
        'He fought well.',
        'The battle ended.',
        'The Journey Home',
        'He walked.',
        'He arrived.',
      ],
      'Test',
      signals,
    )
    const result = detectOutline(input)
    expect(result.detected).toBe(true)
    expect(result.chapters).toHaveLength(2)
    expect(result.chapters[0]?.title).toBe('A Hero Appears')
    expect(result.chapters[1]?.title).toBe('The Journey Home')
  })

  it('uses font-size to detect Level 2 sub-headings', () => {
    const signals = [12, 12, 16, 12, 16, 12]
    const input = flat(
      [
        'Body text one.',
        'Body text two.',
        'A Sub Section',
        'More body.',
        'Another Sub',
        'End body.',
      ],
      'Test',
      signals,
    )
    const result = detectOutline(input)
    expect(result.detected).toBe(true)
    expect(result.headings[0]).toEqual([
      { paragraphIndex: 2, title: 'A Sub Section' },
      { paragraphIndex: 4, title: 'Another Sub' },
    ])
  })

  it('combines keyword + font-size: keyword headings are always Level 1', () => {
    const signals = [24, 12, 12, 16, 12]
    const input = flat(
      ['Chapter 1', 'Body one.', 'Body two.', 'A Section', 'More body.'],
      'Test',
      signals,
    )
    const result = detectOutline(input)
    expect(result.chapters).toHaveLength(1)
    expect(result.chapters[0]?.title).toBe('Chapter 1')
    expect(result.headings[0]).toEqual([{ paragraphIndex: 2, title: 'A Section' }])
  })

  it('ignores signals when they do not align with paragraphs', () => {
    const signals = [24, 12]
    const input = flat(['Chapter 1', 'Body.', 'Chapter 2', 'Body two.'], 'Test', signals)
    const result = detectOutline(input)
    expect(result.detected).toBe(true)
    expect(result.chapters).toHaveLength(2)
  })

  it('falls back to regex-only when signals are undefined', () => {
    const input = flat(['Chapter 1', 'Body.', 'Chapter 2', 'Body two.'])
    const result = detectOutline(input)
    expect(result.detected).toBe(true)
    expect(result.chapters).toHaveLength(2)
    expect(result.headings).toEqual([[], []])
  })
})
