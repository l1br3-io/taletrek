import { cleanText, isPageNumberLine } from './filters'
import { applyPronunciation } from './pronunciation'
import type { CleaningConfig } from './types'

/** A cleaned paragraph paired with its index in the original (raw) array. */
export interface CleanedParagraphWithOrigin {
  text: string
  /** Index of the source paragraph in the raw `paragraphs` array. */
  rawIndex: number
}

export function cleanParagraphsWithOrigins(
  paragraphs: string[],
  config: CleaningConfig,
): CleanedParagraphWithOrigin[] {
  if (!config.enabled) {
    return paragraphs.map((text, rawIndex) => ({ text, rawIndex }))
  }
  const out: CleanedParagraphWithOrigin[] = []
  for (let rawIndex = 0; rawIndex < paragraphs.length; rawIndex++) {
    const p = paragraphs[rawIndex]
    if (p === undefined) continue
    if (config.filters.pageNumbers && isPageNumberLine(p)) continue
    const cleaned = applyPronunciation(cleanText(p, config.filters), config.pronunciation)
    if (cleaned.length === 0) continue
    out.push({ text: cleaned, rawIndex })
  }
  return out
}

export function cleanParagraphs(paragraphs: string[], config: CleaningConfig): string[] {
  if (!config.enabled) return paragraphs
  return cleanParagraphsWithOrigins(paragraphs, config).map((o) => o.text)
}

export function cleanChapters<T extends { paragraphs: string[] }>(
  chapters: T[],
  config: CleaningConfig,
): T[] {
  if (!config.enabled) return chapters
  return chapters.map((ch) => ({ ...ch, paragraphs: cleanParagraphs(ch.paragraphs, config) }))
}

export type { CleaningConfig, CleaningFilters, PronunciationEntry } from './types'
