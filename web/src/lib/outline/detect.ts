import type { ChapterHeading } from '../../types'
import type { ParsedChapter } from '../parse/types'

/**
 * Result of outline detection. When `detected` is false, `chapters` is the
 * input unchanged and `headings` is empty — callers should treat the book as
 * already-segmented (or unsegmentable) and skip the write.
 */
export interface OutlineDetectionResult {
  chapters: ParsedChapter[]
  /** Sub-headings within each chapter. `headings[i]` = sub-headings for `chapters[i]`. */
  headings: ChapterHeading[][]
  detected: boolean
}

/** Heading keywords that start a new chapter (Level 1). */
const HEADING_KEYWORD_RE = /^(chapter|part|book|section|prologue|epilogue|interlude)\b/i

/** Numeric/lettered section patterns (Level 2 sub-headings). */
const NUMERIC_SECTION_RE = /^(?:\d+(?:\.\d+)*\.?\s+|[A-F]\.\s+|§\d+(?:\.\d+)*\s?)/i

const MAX_HEADING_LEN = 80
const MAX_ALLCAPS_LEN = 60
const MAX_NUMERIC_LEN = 60

/** Font-size ratio thresholds (relative to body median). */
const LEVEL1_SIGNAL_RATIO = 1.4
const LEVEL2_SIGNAL_RATIO = 1.2

/**
 * True when a paragraph looks like a heading: keyword match, all-caps short
 * line, numeric section pattern, or font-size signal above the Level 2 threshold.
 */
export function isHeading(paragraph: string, signal?: number, median?: number): boolean {
  const text = paragraph.trim()
  if (text.length === 0 || text.length > MAX_HEADING_LEN) return false
  if (HEADING_KEYWORD_RE.test(text)) return true
  if (isAllCapsShort(text)) return true
  if (isNumericSection(text)) return true
  if (signal !== undefined && median !== undefined && median > 0) {
    return signal >= median * LEVEL2_SIGNAL_RATIO
  }
  return false
}

/**
 * All-caps heuristic: >= 3 letters, all uppercase, <= 60 chars, and doesn't end
 * with sentence punctuation (so "THE END." is rejected — it's body, not a
 * heading).
 */
function isAllCapsShort(text: string): boolean {
  if (text.length > MAX_ALLCAPS_LEN) return false
  const letters = text.replace(/[^A-Za-z]/g, '')
  if (letters.length < 3) return false
  if (letters !== letters.toUpperCase()) return false
  if (/[.!?;:]$/.test(text)) return false
  return true
}

/** Numeric/lettered section: "1. Intro", "1.1 Overview", "A. Methods", "§1". */
function isNumericSection(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length > MAX_NUMERIC_LEN) return false
  if (/[.!?]$/.test(trimmed)) return false
  if (!NUMERIC_SECTION_RE.test(trimmed)) return false
  const afterPrefix = trimmed.replace(NUMERIC_SECTION_RE, '')
  return /[a-zA-Z]/.test(afterPrefix)
}

/** Compute the median of a non-empty array of positive numbers. */
function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0)
}

interface HeadingCandidate {
  index: number
  level: 1 | 2
  title: string
}

/**
 * Re-segment a flat (single-chapter) parse into chapters by detecting heading
 * paragraphs. Returns the input unchanged when:
 *  - the input already has multiple chapters (EPUB spine, etc.)
 *  - no headings are detected
 *
 * Headings are classified into two levels:
 *  - **Level 1** (chapter boundary): keyword match (Chapter, Part, etc.) OR
 *    font-size signal >= 1.4x body median. Creates a new chapter.
 *  - **Level 2** (sub-heading): moderate font-size signal, numeric section
 *    pattern, or all-caps short line. Stays in the chapter body as a
 *    navigable anchor (recorded in `headings`).
 *
 * The Level 1 heading paragraph becomes the chapter title and is excluded from
 * body paragraphs. Level 2 heading paragraphs stay in the body.
 */
export function detectOutline(input: ParsedChapter[]): OutlineDetectionResult {
  if (input.length !== 1) return { chapters: input, headings: [], detected: false }

  const flat = input[0]
  if (!flat) return { chapters: input, headings: [], detected: false }

  const paragraphs = flat.paragraphs
  const signals = flat.headingSignals
  const alignedSignals = signals && signals.length === paragraphs.length ? signals : undefined
  const validSignals = alignedSignals?.filter((s) => s > 0) ?? []
  const med = validSignals.length > 0 ? median(validSignals) : 0

  const candidates: HeadingCandidate[] = []
  for (let i = 0; i < paragraphs.length; i++) {
    const text = paragraphs[i] ?? ''
    const signal = alignedSignals?.[i]
    if (!isHeading(text, signal, med)) continue
    const level: 1 | 2 = isLevel1(text, signal, med) ? 1 : 2
    candidates.push({ index: i, level, title: text.trim() })
  }

  if (candidates.length === 0) {
    return { chapters: input, headings: [], detected: false }
  }

  const level1 = candidates.filter((c) => c.level === 1)

  if (level1.length === 0) {
    const subHeadings: ChapterHeading[] = candidates.map((c) => ({
      paragraphIndex: c.index,
      title: c.title,
    }))
    return {
      chapters: input,
      headings: [subHeadings],
      detected: true,
    }
  }

  const chapters: ParsedChapter[] = []
  const chapterHeadings: ChapterHeading[][] = []

  const firstL1 = level1[0]?.index ?? 0
  if (firstL1 > 0) {
    const end = firstL1
    chapters.push({
      title: flat.title.trim() || 'Front Matter',
      paragraphs: paragraphs.slice(0, end),
      headingSignals: alignedSignals?.slice(0, end),
    })
    chapterHeadings.push(collectLevel2(candidates, 0, end, 0))
  }

  for (let h = 0; h < level1.length; h++) {
    const start = level1[h]?.index ?? 0
    const end =
      h + 1 < level1.length ? (level1[h + 1]?.index ?? paragraphs.length) : paragraphs.length
    const headingText = (paragraphs[start] ?? '').trim()
    const bodyStart = start + 1
    const body = paragraphs.slice(bodyStart, end)
    chapters.push({
      title: headingText,
      paragraphs: body,
      headingSignals: alignedSignals?.slice(bodyStart, end),
    })
    chapterHeadings.push(collectLevel2(candidates, bodyStart, end, bodyStart))
  }

  return { chapters, headings: chapterHeadings, detected: true }
}

/** True when a heading candidate is Level 1 (chapter boundary). */
function isLevel1(text: string, signal?: number, median?: number): boolean {
  if (HEADING_KEYWORD_RE.test(text)) return true
  if (signal !== undefined && median !== undefined && median > 0) {
    return signal >= median * LEVEL1_SIGNAL_RATIO
  }
  return false
}

/**
 * Collect Level 2 headings within a range, adjusting paragraphIndex to be
 * relative to the chapter body (not the original flat paragraph array).
 */
function collectLevel2(
  candidates: HeadingCandidate[],
  rangeStart: number,
  rangeEnd: number,
  bodyOffset: number,
): ChapterHeading[] {
  return candidates
    .filter((c) => c.level === 2 && c.index >= rangeStart && c.index < rangeEnd)
    .map((c) => ({
      paragraphIndex: c.index - bodyOffset,
      title: c.title,
    }))
}
