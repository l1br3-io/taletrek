import type { CleaningFilters } from './types'

export function stripUrls(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\((?:https?:\/\/|www\.)[^\s)]+\)/gi, '$1')
    .replace(/(?:https?:\/\/|www\.)\S+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

export function stripImages(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]+\)/gi, '')
    .replace(/\[(?:image|figure):[^\]]*\]/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

const SUPERSCRIPT_DIGITS = /[\u00b9\u00b2\u00b3\u2070-\u2079]+/g

export function stripFootnoteRefs(text: string): string {
  return text
    .replace(/\[\d{1,3}\]:?/g, '')
    .replace(SUPERSCRIPT_DIGITS, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

export function isPageNumberLine(text: string): boolean {
  return /^\s*\d{1,4}\s*$/.test(text) || /^\s*page\s+\d+\s*$/i.test(text)
}

export function cleanText(text: string, filters: CleaningFilters): string {
  let out = text
  if (filters.images) out = stripImages(out)
  if (filters.urls) out = stripUrls(out)
  if (filters.footnotes) out = stripFootnoteRefs(out)
  return out.trim()
}
