import { describe, expect, it } from 'vitest'
import { parseFile } from './dispatcher'
import { mdParser } from './md'

function mdFile(name: string, text: string): File {
  return new File([text], name, { type: 'text/markdown' })
}

describe('mdParser', () => {
  describe('matches', () => {
    it('matches .md and .markdown extensions (case-insensitive)', () => {
      expect(mdParser.matches(new File([], 'a.md'))).toBe(true)
      expect(mdParser.matches(new File([], 'a.MD'))).toBe(true)
      expect(mdParser.matches(new File([], 'a.markdown'))).toBe(true)
      expect(mdParser.matches(new File([], 'a.MARKDOWN'))).toBe(true)
    })

    it('matches by markdown mime type', () => {
      expect(mdParser.matches(new File([], 'file', { type: 'text/markdown' }))).toBe(true)
      expect(mdParser.matches(new File([], 'file', { type: 'text/x-markdown' }))).toBe(true)
    })

    it('does not match non-markdown files', () => {
      expect(mdParser.matches(new File([], 'a.pdf', { type: 'application/pdf' }))).toBe(false)
      expect(mdParser.matches(new File([], 'a.txt', { type: 'text/plain' }))).toBe(false)
      expect(mdParser.matches(new File([], 'a.epub', { type: 'application/epub+zip' }))).toBe(false)
    })
  })

  describe('inline syntax stripping', () => {
    it('strips bold and italic markers', async () => {
      const result = await mdParser.parse(
        mdFile('test.md', 'Some **bold** and *italic* and ***both*** text.'),
      )
      expect(result.chapters[0]?.paragraphs).toEqual(['Some bold and italic and both text.'])
    })

    it('keeps code span text without backticks', async () => {
      const result = await mdParser.parse(mdFile('test.md', 'Use the `someFunction()` helper.'))
      expect(result.chapters[0]?.paragraphs).toEqual(['Use the someFunction() helper.'])
    })

    it('extracts link text and discards the URL', async () => {
      const result = await mdParser.parse(
        mdFile('test.md', 'See [the docs](https://example.com) for more.'),
      )
      expect(result.chapters[0]?.paragraphs).toEqual(['See the docs for more.'])
    })

    it('discards images entirely', async () => {
      const result = await mdParser.parse(
        mdFile('test.md', 'Before.\n\n![alt text](image.png)\n\nAfter.'),
      )
      expect(result.chapters[0]?.paragraphs).toEqual(['Before.', 'After.'])
    })

    it('discards fenced code blocks', async () => {
      const result = await mdParser.parse(
        mdFile('test.md', 'Intro.\n\n```js\nconst x = 1;\nconsole.log(x);\n```\n\nOutro.'),
      )
      expect(result.chapters[0]?.paragraphs).toEqual(['Intro.', 'Outro.'])
    })
  })

  describe('block elements', () => {
    it('extracts list items as separate paragraphs', async () => {
      const result = await mdParser.parse(mdFile('test.md', '- Apple\n- Banana\n- Cherry'))
      expect(result.chapters[0]?.paragraphs).toEqual(['Apple', 'Banana', 'Cherry'])
    })

    it('extracts blockquote text', async () => {
      const result = await mdParser.parse(mdFile('test.md', '> To be or not to be.'))
      expect(result.chapters[0]?.paragraphs).toEqual(['To be or not to be.'])
    })
  })

  describe('chapter splitting', () => {
    it('splits into chapters by H1 headings', async () => {
      const result = await mdParser.parse(
        mdFile(
          'book.md',
          '# Chapter One\n\nFirst paragraph.\n\n# Chapter Two\n\nSecond paragraph.',
        ),
      )
      expect(result.chapters).toHaveLength(2)
      expect(result.chapters[0]?.title).toBe('Chapter One')
      expect(result.chapters[0]?.paragraphs).toEqual(['First paragraph.'])
      expect(result.chapters[1]?.title).toBe('Chapter Two')
      expect(result.chapters[1]?.paragraphs).toEqual(['Second paragraph.'])
    })

    it('puts content before the first H1 into a chapter titled from the filename', async () => {
      const result = await mdParser.parse(
        mdFile('My Book.md', 'Introduction.\n\n# Chapter One\n\nBody.'),
      )
      expect(result.chapters).toHaveLength(2)
      expect(result.chapters[0]?.title).toBe('My Book')
      expect(result.chapters[0]?.paragraphs).toEqual(['Introduction.'])
      expect(result.chapters[1]?.title).toBe('Chapter One')
    })

    it('treats H2-H6 as paragraph text within the current chapter', async () => {
      const result = await mdParser.parse(
        mdFile('test.md', '# Chapter\n\n## Section\n\nText.\n\n### Subsection\n\nMore.'),
      )
      expect(result.chapters).toHaveLength(1)
      expect(result.chapters[0]?.paragraphs).toEqual(['Section', 'Text.', 'Subsection', 'More.'])
    })
  })

  describe('title and edge cases', () => {
    it('derives the book title from the filename', async () => {
      const result = await mdParser.parse(mdFile('Great Notes.md', 'Hello world.'))
      expect(result.title).toBe('Great Notes')
    })

    it('handles an empty file gracefully', async () => {
      const result = await mdParser.parse(mdFile('empty.md', ''))
      expect(result.title).toBe('empty')
      expect(result.chapters).toHaveLength(1)
      expect(result.chapters[0]?.paragraphs).toEqual([])
    })

    it('creates a single chapter when there are no H1 headings', async () => {
      const result = await mdParser.parse(mdFile('notes.md', 'Just some notes.\n\nMore notes.'))
      expect(result.chapters).toHaveLength(1)
      expect(result.chapters[0]?.paragraphs).toEqual(['Just some notes.', 'More notes.'])
    })
  })
})

describe('parseFile dispatcher', () => {
  it('routes .md to the markdown parser', async () => {
    const result = await parseFile(mdFile('book.md', '# Title\n\nBody text.'))
    expect(result.chapters[0]?.title).toBe('Title')
    expect(result.chapters[0]?.paragraphs).toEqual(['Body text.'])
  })
})
