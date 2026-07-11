import { cleanText, isPageNumberLine } from './filters'
import { applyPronunciation } from './pronunciation'
import type { CleaningConfig } from './types'

export function cleanParagraphs(paragraphs: string[], config: CleaningConfig): string[] {
  if (!config.enabled) return paragraphs
  return paragraphs
    .filter((p) => !(config.filters.pageNumbers && isPageNumberLine(p)))
    .map((p) => applyPronunciation(cleanText(p, config.filters), config.pronunciation))
    .filter((p) => p.length > 0)
}

export function cleanChapters<T extends { paragraphs: string[] }>(
  chapters: T[],
  config: CleaningConfig,
): T[] {
  if (!config.enabled) return chapters
  return chapters.map((ch) => ({ ...ch, paragraphs: cleanParagraphs(ch.paragraphs, config) }))
}

export type { CleaningConfig, CleaningFilters, PronunciationEntry } from './types'
