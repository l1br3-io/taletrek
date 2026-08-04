import { describe, expect, it } from 'vitest'
import { bookId, chapterId } from '../../types'
import {
  chapterTextToChapter,
  chapterToChapterText,
  MANIFEST_SCHEMA_VERSION,
  READABLE_AUDIO_CODECS,
  SPA_GENERATOR_APP,
  SUPPORTED_SCHEMA_VERSIONS,
  WRITABLE_AUDIO_CODEC,
} from './manifest'

describe('bundle manifest constants', () => {
  it('pins schemaVersion to the frozen v1', () => {
    expect(MANIFEST_SCHEMA_VERSION).toBe(1)
    expect(SUPPORTED_SCHEMA_VERSIONS).toEqual([1])
  })

  it('reader accepts Opus + M4A + WAV (format doc §Conformance)', () => {
    expect(READABLE_AUDIO_CODECS).toEqual(['opus', 'm4a', 'wav'])
  })

  it('writer emits Opus for v1', () => {
    expect(WRITABLE_AUDIO_CODEC).toBe('opus')
  })

  it('stamps the SPA generator app', () => {
    expect(SPA_GENERATOR_APP).toBe('taletrek-spa')
  })
})

describe('chapterTextToChapter', () => {
  it('maps a wire ChapterText onto a SPA Chapter using the provided branded ids', () => {
    const ct = {
      id: 'ch_bundle',
      bookId: 'bk_bundle',
      index: 2,
      title: 'Chapter Three',
      paragraphs: ['One.', 'Two.'],
      headings: [{ paragraphIndex: 0, title: 'A section' }],
    }
    const bid = bookId('bk_local')
    const cid = chapterId('ch_local')

    const ch = chapterTextToChapter(ct, { bookId: bid, chapterId: cid })

    expect(ch.id).toBe(cid)
    expect(ch.bookId).toBe(bid)
    expect(ch.index).toBe(2)
    expect(ch.title).toBe('Chapter Three')
    expect(ch.paragraphs).toEqual(['One.', 'Two.'])
    expect(ch.headings).toEqual([{ paragraphIndex: 0, title: 'A section' }])
  })

  it('omits headings when the wire chapter has none (older books)', () => {
    const ch = chapterTextToChapter(
      { id: 'x', bookId: 'x', index: 0, title: 'T', paragraphs: [] },
      { bookId: bookId('b'), chapterId: chapterId('c') },
    )
    expect(ch.headings).toBeUndefined()
  })
})

describe('chapterToChapterText', () => {
  it('maps a SPA Chapter onto the wire ChapterText shape', () => {
    const ch = {
      id: chapterId('ch_1'),
      bookId: bookId('bk_1'),
      index: 4,
      title: 'Five',
      paragraphs: ['a', 'b'],
      headings: [{ paragraphIndex: 1, title: 'sec' }],
    }
    const ct = chapterToChapterText(ch)
    expect(ct).toEqual({
      id: 'ch_1',
      bookId: 'bk_1',
      index: 4,
      title: 'Five',
      paragraphs: ['a', 'b'],
      headings: [{ paragraphIndex: 1, title: 'sec' }],
    })
  })

  it('omits headings on the wire when the Chapter has none', () => {
    const ct = chapterToChapterText({
      id: chapterId('c'),
      bookId: bookId('b'),
      index: 0,
      title: 't',
      paragraphs: ['p'],
    })
    expect(ct.headings).toBeUndefined()
  })
})

describe('chapterText ↔ Chapter round-trip', () => {
  it('preserves index/title/paragraphs/headings across both directions', () => {
    const original = {
      id: 'irrelevant',
      bookId: 'also-irrelevant',
      index: 7,
      title: 'Round',
      paragraphs: ['x', 'y', 'z'],
      headings: [{ paragraphIndex: 0, title: 'h' }],
    }
    const ch = chapterTextToChapter(original, {
      bookId: bookId('bk'),
      chapterId: chapterId('ch'),
    })
    const back = chapterToChapterText(ch)
    expect(back.index).toBe(7)
    expect(back.title).toBe('Round')
    expect(back.paragraphs).toEqual(['x', 'y', 'z'])
    expect(back.headings).toEqual([{ paragraphIndex: 0, title: 'h' }])
    // ids are the freshly-allocated locals (importer allocates; exporter keeps).
    expect(back.id).toBe('ch')
    expect(back.bookId).toBe('bk')
  })
})
