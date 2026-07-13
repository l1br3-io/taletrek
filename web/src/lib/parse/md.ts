import type { Token, Tokens } from 'marked'
import { marked } from 'marked'
import type { BookFormat } from '../../types'
import type { ParsedChapter, Parser } from './types'
import { extensionOf, titleFromFilename } from './util'

const MD_EXTENSIONS = new Set(['md', 'markdown'])
const MD_MIME_TYPES = new Set(['text/markdown', 'text/x-markdown'])

function inlineText(tokens: Token[] | undefined): string {
  if (!tokens) return ''
  let out = ''
  for (const t of tokens) {
    switch (t.type) {
      case 'text':
      case 'escape':
        out += (t as Tokens.Text).text
        break
      case 'strong':
      case 'em':
      case 'del':
        out += inlineText((t as Tokens.Strong).tokens)
        break
      case 'codespan':
        out += (t as Tokens.Codespan).text
        break
      case 'link':
        out += inlineText((t as Tokens.Link).tokens)
        break
      case 'image':
      case 'html':
      case 'br':
        break
    }
  }
  return out
}

function blockText(token: Token): string[] {
  switch (token.type) {
    case 'paragraph': {
      const t = inlineText((token as Tokens.Paragraph).tokens).trim()
      return t ? [t] : []
    }
    case 'heading': {
      const t = inlineText((token as Tokens.Heading).tokens).trim()
      return t ? [t] : []
    }
    case 'list': {
      const out: string[] = []
      for (const item of (token as Tokens.List).items) {
        const t = inlineText(item.tokens).trim()
        if (t) out.push(t)
      }
      return out
    }
    case 'blockquote': {
      const out: string[] = []
      for (const inner of (token as Tokens.Blockquote).tokens) {
        out.push(...blockText(inner))
      }
      return out
    }
    default:
      return []
  }
}

export const mdParser: Parser = {
  format: 'md' satisfies BookFormat,
  matches(file) {
    return MD_EXTENSIONS.has(extensionOf(file.name)) || MD_MIME_TYPES.has(file.type)
  },
  async parse(file) {
    const text = await file.text()
    const tokens = marked.lexer(text)

    const chapters: ParsedChapter[] = []
    const bookTitle = titleFromFilename(file.name)
    let current: ParsedChapter | null = null

    const ensureChapter = (): ParsedChapter => {
      if (!current) current = { title: bookTitle, paragraphs: [] }
      return current
    }

    for (const token of tokens) {
      if (token.type === 'heading' && (token as Tokens.Heading).depth === 1) {
        if (current) chapters.push(current)
        const headingText = inlineText((token as Tokens.Heading).tokens).trim()
        current = { title: headingText || bookTitle, paragraphs: [] }
      } else {
        const paras = blockText(token)
        if (paras.length > 0) {
          const ch = ensureChapter()
          ch.paragraphs.push(...paras)
        }
      }
    }

    if (current) chapters.push(current)
    if (chapters.length === 0) chapters.push({ title: bookTitle, paragraphs: [] })

    return { title: bookTitle, chapters }
  },
}
