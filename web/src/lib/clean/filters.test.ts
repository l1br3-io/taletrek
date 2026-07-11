import { describe, expect, it } from 'vitest'
import { cleanText, isPageNumberLine, stripFootnoteRefs, stripImages, stripUrls } from './filters'
import type { CleaningFilters } from './types'

const ALL_ON: CleaningFilters = { urls: true, images: true, footnotes: true, pageNumbers: true }
const ALL_OFF: CleaningFilters = {
  urls: false,
  images: false,
  footnotes: false,
  pageNumbers: false,
}

describe('stripUrls', () => {
  it('drops a bare https url', () => {
    expect(stripUrls('see https://example.com/x now')).toBe('see now')
  })

  it('drops a bare http url', () => {
    expect(stripUrls('visit http://foo.io/a/b')).toBe('visit')
  })

  it('drops a bare www domain', () => {
    expect(stripUrls('go www.example.com here')).toBe('go here')
  })

  it('keeps link text from a markdown link', () => {
    expect(stripUrls('[click here](http://x.io/y)')).toBe('click here')
  })

  it('keeps link text but drops a www markdown url', () => {
    expect(stripUrls('[docs](www.example.com)')).toBe('docs')
  })

  it('does not touch a bracketed non-url', () => {
    expect(stripUrls('[see chapter 5](not-a-url)')).toBe('[see chapter 5](not-a-url)')
  })

  it('handles multiple urls in one paragraph', () => {
    expect(stripUrls('a https://x.io and http://y.io')).toBe('a and')
  })

  it('collapses double spaces left behind', () => {
    expect(stripUrls('before https://x.io  after')).toBe('before after')
  })
})

describe('stripImages', () => {
  it('drops a markdown image entirely', () => {
    expect(stripImages('text ![a diagram](http://x.io/x.png) tail')).toBe('text tail')
  })

  it('drops a bracketed image marker', () => {
    expect(stripImages('see [Image: figure 1] here')).toBe('see here')
  })

  it('drops a bracketed figure marker (case-insensitive)', () => {
    expect(stripImages('see [FIGURE: 2] here')).toBe('see here')
  })

  it('leaves ordinary brackets alone', () => {
    expect(stripImages('[a note] in text')).toBe('[a note] in text')
  })
})

describe('stripFootnoteRefs', () => {
  it('drops a single inline ref', () => {
    expect(stripFootnoteRefs('a claim[1] was made')).toBe('a claim was made')
  })

  it('drops a double-digit inline ref', () => {
    expect(stripFootnoteRefs('see[42] below')).toBe('see below')
  })

  it('drops a footnote definition prefix', () => {
    expect(stripFootnoteRefs('[1]: some note text')).toBe('some note text')
  })

  it('drops superscript digits', () => {
    expect(stripFootnoteRefs('mass\u00b2 is energy')).toBe('mass is energy')
  })

  it('does NOT drop a parenthesized year', () => {
    expect(stripFootnoteRefs('published (1984) later')).toBe('published (1984) later')
  })

  it('does NOT drop a large bracketed number', () => {
    expect(stripFootnoteRefs('ref[1234] here')).toBe('ref[1234] here')
  })
})

describe('isPageNumberLine', () => {
  it('flags a bare number', () => {
    expect(isPageNumberLine('42')).toBe(true)
  })

  it('flags a number with surrounding whitespace', () => {
    expect(isPageNumberLine('  7  ')).toBe(true)
  })

  it('flags a "page N" line', () => {
    expect(isPageNumberLine('page 12')).toBe(true)
  })

  it('flags a "Page N" line (case-insensitive)', () => {
    expect(isPageNumberLine('Page 99')).toBe(true)
  })

  it('does not flag a sentence', () => {
    expect(isPageNumberLine('Chapter 42')).toBe(false)
  })

  it('does not flag a paragraph starting with a number', () => {
    expect(isPageNumberLine('42 men arrived')).toBe(false)
  })

  it('does not flag a 5-digit number', () => {
    expect(isPageNumberLine('12345')).toBe(false)
  })
})

describe('cleanText', () => {
  it('applies all active filters in order', () => {
    const out = cleanText('see [1] and https://x.io plus ![img](http://y.io/z.png) end', ALL_ON)
    expect(out).toBe('see and plus end')
  })

  it('is a no-op when all filters are off', () => {
    const text = 'keep [1] and https://x.io intact'
    expect(cleanText(text, ALL_OFF)).toBe(text)
  })

  it('applies only the enabled filters', () => {
    const onlyFootnotes: CleaningFilters = {
      urls: false,
      images: false,
      footnotes: true,
      pageNumbers: false,
    }
    expect(cleanText('keep [1] and https://x.io', onlyFootnotes)).toBe('keep and https://x.io')
  })
})
