import { describe, expect, it } from 'vitest'
import { cleanChapters, cleanParagraphs } from './index'
import type { CleaningConfig } from './types'

const CONFIG: CleaningConfig = {
  enabled: true,
  filters: { urls: true, images: true, footnotes: true, pageNumbers: true },
  pronunciation: [],
}

function withPronunciation(find: string, replace: string): CleaningConfig {
  return { ...CONFIG, pronunciation: [{ id: 'p1', find, replace }] }
}

describe('cleanParagraphs', () => {
  it('drops a page-number paragraph and keeps the rest', () => {
    const out = cleanParagraphs(['42', 'real text', 'page 7'], CONFIG)
    expect(out).toEqual(['real text'])
  })

  it('strips urls and footnote refs within paragraphs', () => {
    const out = cleanParagraphs(['see [1] and https://x.io now'], CONFIG)
    expect(out).toEqual(['see and now'])
  })

  it('drops a paragraph that becomes empty after cleaning', () => {
    const out = cleanParagraphs(['[1] https://x.io ![i](http://y.io/z.png)'], CONFIG)
    expect(out).toEqual([])
  })

  it('applies pronunciation after structural filters', () => {
    const out = cleanParagraphs(['hello Siobhan [1]'], withPronunciation('Siobhan', 'shi-vawn'))
    expect(out).toEqual(['hello shi-vawn'])
  })

  it('returns the same reference when disabled', () => {
    const input = ['[1] https://x.io 42']
    const disabled: CleaningConfig = { ...CONFIG, enabled: false }
    expect(cleanParagraphs(input, disabled)).toBe(input)
  })

  it('preserves order of survivors', () => {
    const out = cleanParagraphs(['a', '42', 'b', 'page 3', 'c'], CONFIG)
    expect(out).toEqual(['a', 'b', 'c'])
  })
})

describe('cleanChapters', () => {
  function chapters(): Array<{ title: string; index: number; id: string; paragraphs: string[] }> {
    return [
      {
        title: 'One',
        index: 0,
        id: 'c1',
        paragraphs: ['42', 'see [1] and https://x.io end', 'plain'],
      },
      {
        title: 'Two',
        index: 1,
        id: 'c2',
        paragraphs: ['page 9', 'all good'],
      },
    ]
  }

  it('rewrites paragraphs and preserves all other fields', () => {
    const out = cleanChapters(chapters(), CONFIG)
    expect(out[0]).toEqual({
      title: 'One',
      index: 0,
      id: 'c1',
      paragraphs: ['see and end', 'plain'],
    })
    expect(out[1]).toEqual({
      title: 'Two',
      index: 1,
      id: 'c2',
      paragraphs: ['all good'],
    })
  })

  it('returns the same reference when disabled', () => {
    const input = chapters()
    const disabled: CleaningConfig = { ...CONFIG, enabled: false }
    expect(cleanChapters(input, disabled)).toBe(input)
  })

  it('produces an empty paragraphs array when everything is stripped', () => {
    const out = cleanChapters(
      [{ title: 'Noise', index: 0, id: 'c', paragraphs: ['42', 'page 1', '[1]'] }],
      CONFIG,
    )
    expect(out[0]?.paragraphs).toEqual([])
  })

  it('does not mutate the input chapters', () => {
    const input = chapters()
    const snapshot = JSON.parse(JSON.stringify(input))
    cleanChapters(input, CONFIG)
    expect(JSON.parse(JSON.stringify(input))).toEqual(snapshot)
  })
})
