import { describe, expect, it } from 'vitest'
import type { TextItem } from './pdf'
import {
  extractOutline,
  groupItemsIntoParagraphs,
  groupPagesIntoChapters,
  type OutlineEntry,
  type PageParagraph,
  pdfParser,
} from './pdf'

function item(str: string, y: number, size = 12): TextItem {
  return { str, transform: [size, 0, 0, size, 0, y], height: size }
}

function para(text: string, y: number): PageParagraph {
  return { text, y }
}

describe('groupItemsIntoParagraphs', () => {
  it('joins items on the same line into one paragraph', () => {
    const result = groupItemsIntoParagraphs([item('Hello', 100), item('world', 100)])
    expect(result).toEqual([{ text: 'Hello world', y: 100 }])
  })

  it('treats a small vertical step as a line wrap within a paragraph', () => {
    const result = groupItemsIntoParagraphs([item('Line one', 100), item('wrapped here.', 88)])
    expect(result).toEqual([{ text: 'Line one wrapped here.', y: 100 }])
  })

  it('starts a new paragraph on a large vertical gap, preserving each Y', () => {
    const result = groupItemsIntoParagraphs([
      item('First paragraph.', 100),
      item('Second paragraph.', 70),
    ])
    expect(result).toEqual([
      { text: 'First paragraph.', y: 100 },
      { text: 'Second paragraph.', y: 70 },
    ])
  })

  it('handles multiple paragraphs and wrapped lines together', () => {
    const result = groupItemsIntoParagraphs([
      item('Para one line a', 100),
      item('para one line b', 88),
      item('Para two', 60),
      item('para two b', 48),
    ])
    expect(result).toEqual([
      { text: 'Para one line a para one line b', y: 100 },
      { text: 'Para two para two b', y: 60 },
    ])
  })

  it('returns empty for no items', () => {
    expect(groupItemsIntoParagraphs([])).toEqual([])
  })
})

describe('pdfParser', () => {
  it('matches by extension (case-insensitive) and by mime', () => {
    expect(pdfParser.matches(new File([], 'book.pdf', { type: 'application/pdf' }))).toBe(true)
    expect(pdfParser.matches(new File([], 'book.PDF', { type: '' }))).toBe(true)
    expect(pdfParser.matches(new File([], 'book.txt', { type: 'text/plain' }))).toBe(false)
  })
})

describe('extractOutline — Tier 1 (mocked doc)', () => {
  type OutlineNode = {
    title: string
    dest: string | Array<unknown> | null
    items: Array<unknown>
  }
  function mockDoc(outline: OutlineNode[] | null): unknown {
    const dests = new Map<string, Array<unknown>>()
    for (const n of outline ?? []) {
      if (typeof n.dest === 'string') {
        const pageRef = Number(n.dest.replace('ref-', ''))
        dests.set(n.dest, [{ num: pageRef, gen: 0 }, { name: 'XYZ' }, 0, 500, 0])
      }
    }
    return {
      async getOutline() {
        return outline
      },
      async getDestination(id: string) {
        return dests.get(id) ?? null
      },
      async getPageIndex(ref: unknown) {
        if (typeof ref === 'object' && ref !== null && 'num' in ref) {
          const n = Number((ref as { num: unknown }).num)
          return Number.isFinite(n) ? n : -1
        }
        const n = Number(ref)
        return Number.isFinite(n) ? n : -1
      },
    }
  }

  it('returns null when PDF has no outline', async () => {
    const result = await extractOutline(mockDoc(null) as never)
    expect(result).toBeNull()
  })

  it('returns null when fewer than 2 entries resolve', async () => {
    const doc = mockDoc([
      { title: 'Only', dest: [{ num: 0, gen: 0 }, { name: 'XYZ' }, 0, 500, 0], items: [] },
    ])
    const result = await extractOutline(doc as never)
    expect(result).toBeNull()
  })

  it('resolves string destinations via getDestination and captures startY from /XYZ top (index 3)', async () => {
    const doc = mockDoc([
      { title: 'Chapter 1', dest: 'ref-0', items: [] },
      { title: 'Chapter 2', dest: 'ref-5', items: [] },
    ])
    const result = await extractOutline(doc as never)
    expect(result).not.toBeNull()
    expect(
      result?.map((e) => ({ title: e.title, pageIndex: e.pageIndex, startY: e.startY })),
    ).toEqual([
      { title: 'Chapter 1', pageIndex: 0, startY: 500 },
      { title: 'Chapter 2', pageIndex: 5, startY: 500 },
    ])
  })

  it('resolves explicit array destinations directly and reads top from index 3', async () => {
    const doc = mockDoc([
      { title: 'Ch1', dest: [{ num: 3, gen: 0 }, { name: 'XYZ' }, 0, 400, 0], items: [] },
      { title: 'Ch2', dest: [{ num: 10, gen: 0 }, { name: 'XYZ' }, 0, 350, 0], items: [] },
    ])
    const result = await extractOutline(doc as never)
    expect(result?.[1]?.pageIndex).toBe(10)
    expect(result?.[1]?.startY).toBe(350)
  })

  it('extracts top from /FitH dests (index 2)', async () => {
    const doc = mockDoc([
      { title: 'Ch1', dest: [{ num: 0, gen: 0 }, { name: 'FitH' }, 600], items: [] },
      { title: 'Ch2', dest: [{ num: 5, gen: 0 }, { name: 'FitH' }, 550], items: [] },
    ])
    const result = await extractOutline(doc as never)
    expect(result?.[0]?.startY).toBe(600)
    expect(result?.[1]?.startY).toBe(550)
  })

  it('extracts top from /FitR dests (index 5)', async () => {
    const doc = mockDoc([
      { title: 'Ch1', dest: [{ num: 0, gen: 0 }, { name: 'FitR' }, 0, 0, 612, 700], items: [] },
      { title: 'Ch2', dest: [{ num: 5, gen: 0 }, { name: 'FitR' }, 0, 0, 612, 650], items: [] },
    ])
    const result = await extractOutline(doc as never)
    expect(result?.[0]?.startY).toBe(700)
    expect(result?.[1]?.startY).toBe(650)
  })

  it('sets startY=null for /Fit dests (no position coord)', async () => {
    const doc = mockDoc([
      { title: 'Ch1', dest: [{ num: 0, gen: 0 }, { name: 'Fit' }], items: [] },
      { title: 'Ch2', dest: [{ num: 5, gen: 0 }, { name: 'Fit' }], items: [] },
    ])
    const result = await extractOutline(doc as never)
    expect(result?.[0]?.startY).toBeNull()
    expect(result?.[1]?.startY).toBeNull()
  })

  it('sets startY=null when the type entry is missing or unrecognized', async () => {
    const doc = mockDoc([
      { title: 'Ch1', dest: [{ num: 0, gen: 0 }], items: [] },
      { title: 'Ch2', dest: [{ num: 5, gen: 0 }, 'not-a-name'], items: [] },
    ])
    const result = await extractOutline(doc as never)
    expect(result?.[0]?.startY).toBeNull()
    expect(result?.[1]?.startY).toBeNull()
  })

  it('strips HTML markup from titles', async () => {
    const doc = mockDoc([
      {
        title: '<b>Chapter 1</b>',
        dest: [{ num: 0, gen: 0 }, { name: 'XYZ' }, 0, 500, 0],
        items: [],
      },
      {
        title: '<i>Chapter 2</i>',
        dest: [{ num: 5, gen: 0 }, { name: 'XYZ' }, 0, 500, 0],
        items: [],
      },
    ])
    const result = await extractOutline(doc as never)
    expect(result?.[0]?.title).toBe('Chapter 1')
    expect(result?.[1]?.title).toBe('Chapter 2')
  })

  it('skips malformed entries, keeps the rest', async () => {
    const doc = mockDoc([
      { title: 'Ch1', dest: null, items: [] }, // null dest → skipped
      { title: 'Ch2', dest: [{ num: 2, gen: 0 }, { name: 'XYZ' }, 0, 500, 0], items: [] },
      { title: 'Ch3', dest: [{ num: 5, gen: 0 }, { name: 'XYZ' }, 0, 500, 0], items: [] },
    ])
    const result = await extractOutline(doc as never)
    expect(result).not.toBeNull()
    expect(result?.length).toBe(2)
  })

  it('sorts entries by page index', async () => {
    const doc = mockDoc([
      { title: 'Late', dest: [{ num: 10, gen: 0 }, { name: 'XYZ' }, 0, 500, 0], items: [] },
      { title: 'Early', dest: [{ num: 2, gen: 0 }, { name: 'XYZ' }, 0, 500, 0], items: [] },
    ])
    const result = await extractOutline(doc as never)
    expect(result?.[0]?.title).toBe('Early')
    expect(result?.[1]?.title).toBe('Late')
  })

  it('sorts same-page entries top-to-bottom (descending Y)', async () => {
    const doc = mockDoc([
      { title: 'Lower', dest: [{ num: 5, gen: 0 }, { name: 'XYZ' }, 0, 200, 0], items: [] },
      { title: 'Upper', dest: [{ num: 5, gen: 0 }, { name: 'XYZ' }, 0, 600, 0], items: [] },
    ])
    const result = await extractOutline(doc as never)
    expect(result?.[0]?.title).toBe('Upper')
    expect(result?.[1]?.title).toBe('Lower')
  })
})

describe('groupPagesIntoChapters — Tier 1', () => {
  it('groups whole pages when startY is null', () => {
    const outline: OutlineEntry[] = [
      { title: 'Chapter 1', pageIndex: 0, startY: null },
      { title: 'Chapter 2', pageIndex: 2, startY: null },
      { title: 'Chapter 3', pageIndex: 4, startY: null },
    ]
    const pageParagraphs: PageParagraph[][] = [
      [para('ch1-p1', 700), para('ch1-p2', 600)],
      [para('ch1-p3', 700)],
      [para('ch2-p1', 700)],
      [para('ch2-p2', 600)],
      [para('ch3-p1', 700)],
      [para('ch3-p2', 600)],
    ]
    const result = groupPagesIntoChapters(outline, pageParagraphs, 'Book')
    expect(result.map((c) => c.title)).toEqual(['Chapter 1', 'Chapter 2', 'Chapter 3'])
    expect(result[0]?.paragraphs).toEqual(['ch1-p1', 'ch1-p2', 'ch1-p3'])
    expect(result[1]?.paragraphs).toEqual(['ch2-p1', 'ch2-p2'])
    expect(result[2]?.paragraphs).toEqual(['ch3-p1', 'ch3-p2'])
  })

  it('splits the start page at startY so paragraphs above stay in the previous chapter', () => {
    // Page 1 has 3 paragraphs: top (ch1 tail), middle (ch2 heading), bottom (ch2 body).
    const outline: OutlineEntry[] = [
      { title: 'Chapter 1', pageIndex: 0, startY: null },
      { title: 'Chapter 2', pageIndex: 1, startY: 400 },
    ]
    const pageParagraphs: PageParagraph[][] = [
      [para('ch1-p1', 700)],
      [
        para('ch1-tail', 600), // y > 400 → above the ch2 heading → stays in ch1
        para('ch2-heading', 400), // y == startY → begins ch2
        para('ch2-body', 200), // y < startY → in ch2
      ],
    ]
    const result = groupPagesIntoChapters(outline, pageParagraphs, 'Book')
    expect(result[0]?.paragraphs).toEqual(['ch1-p1', 'ch1-tail'])
    expect(result[1]?.paragraphs).toEqual(['ch2-heading', 'ch2-body'])
  })

  it('handles two chapter starts on the same page', () => {
    const outline: OutlineEntry[] = [
      { title: 'Chapter 1', pageIndex: 0, startY: 700 },
      { title: 'Chapter 2', pageIndex: 0, startY: 400 },
      { title: 'Chapter 3', pageIndex: 0, startY: 200 },
    ]
    const pageParagraphs: PageParagraph[][] = [
      [para('top', 700), para('middle', 400), para('bottom', 200)],
    ]
    const result = groupPagesIntoChapters(outline, pageParagraphs, 'Book')
    expect(result.map((c) => c.title)).toEqual(['Chapter 1', 'Chapter 2', 'Chapter 3'])
    expect(result[0]?.paragraphs).toEqual(['top'])
    expect(result[1]?.paragraphs).toEqual(['middle'])
    expect(result[2]?.paragraphs).toEqual(['bottom'])
  })

  it('emits a front-matter chapter when the first outline entry is not at the top', () => {
    const outline: OutlineEntry[] = [{ title: 'Chapter 1', pageIndex: 2, startY: null }]
    const pageParagraphs: PageParagraph[][] = [
      [para('title', 700)],
      [para('copyright', 700)],
      [para('ch1-p1', 700)],
    ]
    const result = groupPagesIntoChapters(outline, pageParagraphs, 'My Book')
    expect(result[0]?.title).toBe('My Book')
    expect(result[0]?.paragraphs).toEqual(['title', 'copyright'])
    expect(result[1]?.title).toBe('Chapter 1')
  })

  it('emits front matter for paragraphs above the first heading on page 0', () => {
    const outline: OutlineEntry[] = [
      { title: 'Chapter 1', pageIndex: 0, startY: 400 },
      { title: 'Chapter 2', pageIndex: 2, startY: null },
    ]
    const pageParagraphs: PageParagraph[][] = [
      [para('title-page', 700), para('ch1-heading', 400)],
      [para('ch1-body', 700)],
      [para('ch2-p1', 700)],
    ]
    const result = groupPagesIntoChapters(outline, pageParagraphs, 'Book')
    expect(result[0]?.title).toBe('Book')
    expect(result[0]?.paragraphs).toEqual(['title-page'])
    expect(result[1]?.title).toBe('Chapter 1')
    expect(result[1]?.paragraphs).toEqual(['ch1-heading', 'ch1-body'])
  })

  it('strips a leading body paragraph that matches the chapter title', () => {
    const outline: OutlineEntry[] = [
      { title: 'Chapter 1', pageIndex: 0, startY: null },
      { title: 'Chapter 5: The Discovery', pageIndex: 2, startY: null },
    ]
    const pageParagraphs: PageParagraph[][] = [
      [para('Chapter 1', 700), para('ch1-body', 600)],
      [],
      [para('Chapter 5: The Discovery', 700), para('real-body', 600)],
    ]
    const result = groupPagesIntoChapters(outline, pageParagraphs, 'Book')
    expect(result[1]?.paragraphs).toEqual(['real-body'])
  })

  it('does not strip when the leading paragraph only loosely resembles the title', () => {
    const outline: OutlineEntry[] = [
      { title: 'Chapter 5: The Discovery', pageIndex: 0, startY: null },
    ]
    const pageParagraphs: PageParagraph[][] = [[para('Chapter Five', 700), para('body', 600)]]
    const result = groupPagesIntoChapters(outline, pageParagraphs, 'Book')
    expect(result[0]?.paragraphs).toEqual(['Chapter Five', 'body'])
  })

  it('falls back to a single flat chapter when outline produces no entries', () => {
    const result = groupPagesIntoChapters([], [[para('p1', 700)], [para('p2', 600)]], 'Book')
    expect(result).toHaveLength(1)
    expect(result[0]?.title).toBe('Book')
    expect(result[0]?.paragraphs).toEqual(['p1', 'p2'])
  })
})
