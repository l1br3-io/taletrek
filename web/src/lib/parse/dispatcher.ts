import { epubParser } from './epub'
import { pdfParser } from './pdf'
import { txtParser } from './txt'
import type { ParseResult, Parser } from './types'
import { ParseError } from './types'

const parsers: Parser[] = [txtParser, epubParser, pdfParser]

export async function parseFile(file: File): Promise<ParseResult> {
  const parser = parsers.find((p) => p.matches(file))
  if (!parser) {
    throw new ParseError(`Unsupported file type: ${file.name}`)
  }
  try {
    return await parser.parse(file)
  } catch (error) {
    if (error instanceof ParseError) throw error
    throw new ParseError(
      `Failed to parse ${file.name}: ${error instanceof Error ? error.message : 'unknown error'}`,
      parser.format,
    )
  }
}
