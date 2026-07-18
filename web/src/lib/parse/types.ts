import type { BookFormat } from '../../types'

export interface ParsedChapter {
  title: string
  paragraphs: string[]
}

export interface ParseResult {
  title: string
  chapters: ParsedChapter[]
}

export interface Parser {
  format: BookFormat
  matches(file: File): boolean
  parse(file: File): Promise<ParseResult>
}

export class ParseError extends Error {
  override readonly name = 'ParseError'
  constructor(
    message: string,
    readonly format?: BookFormat,
  ) {
    super(message)
  }
}
