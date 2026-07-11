import { describe, expect, it } from 'vitest'
import sampleText from './__fixtures__/sample.txt?raw'
import { parseFile } from './dispatcher'
import { txtParser } from './txt'
import { ParseError } from './types'

function txtFile(name: string, text: string): File {
  return new File([text], name, { type: 'text/plain' })
}

describe('txtParser', () => {
  it('splits text into paragraphs by blank lines', async () => {
    const result = await txtParser.parse(
      txtFile('book.txt', 'Para one.\n\nPara two.\n\nPara three.'),
    )
    expect(result.chapters).toHaveLength(1)
    expect(result.chapters[0]?.paragraphs).toEqual(['Para one.', 'Para two.', 'Para three.'])
  })

  it('joins hard-wrapped lines within a paragraph', async () => {
    const result = await txtParser.parse(
      txtFile('book.txt', 'Line one\nwrapped here.\n\nSecond para.'),
    )
    expect(result.chapters[0]?.paragraphs).toEqual(['Line one wrapped here.', 'Second para.'])
  })

  it('normalizes CRLF line endings', async () => {
    const result = await txtParser.parse(txtFile('book.txt', 'A.\r\n\r\nB.'))
    expect(result.chapters[0]?.paragraphs).toEqual(['A.', 'B.'])
  })

  it('derives the title from the filename', async () => {
    const result = await txtParser.parse(txtFile('My Great Book.txt', 'Hello.'))
    expect(result.title).toBe('My Great Book')
    expect(result.chapters[0]?.title).toBe('My Great Book')
  })

  it('matches by extension (case-insensitive) and by mime', () => {
    expect(txtParser.matches(new File([], 'a.txt', { type: 'text/plain' }))).toBe(true)
    expect(txtParser.matches(new File([], 'a.TXT', { type: '' }))).toBe(true)
    expect(txtParser.matches(new File([], 'random', { type: 'text/plain' }))).toBe(true)
    expect(txtParser.matches(new File([], 'a.pdf', { type: 'application/pdf' }))).toBe(false)
  })

  it('parses the sample fixture into multiple paragraphs', async () => {
    const result = await txtParser.parse(txtFile('sample.txt', sampleText))
    expect(result.title).toBe('sample')
    expect(result.chapters[0]?.paragraphs.length).toBeGreaterThan(3)
  })
})

describe('parseFile dispatcher', () => {
  it('dispatches to the txt parser by extension', async () => {
    const result = await parseFile(txtFile('book.txt', 'Hi.\n\nBye.'))
    expect(result.chapters[0]?.paragraphs).toEqual(['Hi.', 'Bye.'])
  })

  it('throws ParseError for an unsupported file', async () => {
    await expect(
      parseFile(new File([], 'book.unknown', { type: 'application/octet-stream' })),
    ).rejects.toBeInstanceOf(ParseError)
  })
})
