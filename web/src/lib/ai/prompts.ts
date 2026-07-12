/**
 * Per-op prompt templates + output parsing for the AI transform engines.
 *
 * Pure (no network) so both backends (cloud `fetch`, in-browser WebLLM) share
 * identical prompting and output handling. The cloud engine pairs this with
 * `engines/sse.ts` + `fetch`; the in-browser engine (T3) pairs it with WebLLM's
 * `chat.completions.create`.
 */

import type { PronunciationCandidate, PronunciationCategory, TransformOp } from './types'

/** Separates paragraphs in both the user input and the model's textual output. */
export const PARAGRAPH_DELIMITER = '\n\n'

export interface CompletionMessages {
  system: string
  user: string
  /** Request JSON-mode output (pronunciation hints only). */
  json?: boolean
}

/** Build the system + user messages for a transform op over a chunk's paragraphs. */
export function buildTransformMessages(op: TransformOp, paragraphs: string[]): CompletionMessages {
  const user = paragraphs.join(PARAGRAPH_DELIMITER)
  switch (op.kind) {
    case 'cleanup':
      return {
        system:
          'You repair scanned-book text for text-to-speech. Fix OCR errors. Remove inline artifacts: page numbers, running headers/footers, "Chapter N" labels, "|" separators, and stray markup. Repair words broken across a line-end hyphen (join "glimmer-\\ning" into "glimmering"). Return exactly ONE cleaned paragraph per input paragraph, in order, with paragraphs separated by a blank line. Do not add commentary, headings, or markdown. Do not merge or split paragraphs.',
        user,
      }
    case 'translate':
      return {
        system: `You are a literary translator. Translate every input paragraph into language "${op.target}". Preserve paragraph order and count, and the meaning and tone. Return exactly ONE translated paragraph per input paragraph, with paragraphs separated by a blank line. No commentary.`,
        user,
      }
    case 'summarize': {
      const percent = Math.round(op.ratio * 100)
      return {
        system: `Summarize the input to about ${percent}% of its length, keeping the key narrative beats and original order. Return the summary as paragraphs separated by blank lines. No commentary.`,
        user,
      }
    }
    case 'simplify':
      return {
        system: `Rewrite each input paragraph at a Grade ${op.level} reading level: simple words, short sentences. Preserve meaning and paragraph order. Return exactly ONE rewritten paragraph per input paragraph, with paragraphs separated by a blank line. No commentary.`,
        user,
      }
  }
}

/** Build the JSON-mode messages for a pronunciation-hints scan over a sample. */
export function buildHintsMessages(paragraphs: string[]): CompletionMessages {
  return {
    json: true,
    system:
      'You scan book text for terms a text-to-speech engine may mispronounce: proper nouns (people, places, brands), invented/fantasy/sci-fi names, and foreign phrases. For each, propose a phonetic "replace" spelling that makes the TTS voice say it correctly. Return ONLY a JSON object: {"candidates":[{"find":"original term","replace":"phonetic spelling","confidence":0.0to1.0,"category":"proper-noun|foreign|neologism|other"}]}. "confidence" is how likely the replacement improves pronunciation. Omit common words. No prose, only the JSON object.',
    user: paragraphs.join(PARAGRAPH_DELIMITER),
  }
}

/**
 * Split a model's textual completion back into paragraphs. Splits on blank
 * lines, trims, and drops empties. If the model under-delivers (fewer parts than
 * the chunk expected), callers fall back to the original paragraph rather than
 * dropping text — see `CloudLlmEngine.transform`.
 */
export function splitOutput(raw: string): string[] {
  return raw
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
}

const CATEGORIES = new Set<PronunciationCategory>(['proper-noun', 'foreign', 'neologism', 'other'])

function asCategory(value: unknown): PronunciationCategory {
  return typeof value === 'string' && CATEGORIES.has(value as PronunciationCategory)
    ? (value as PronunciationCategory)
    : 'other'
}

function clamp01(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

/**
 * Defensively parse a JSON-mode hints completion into typed candidates. Tolerates
 * either `{candidates:[...]}` or a bare `[...]`, skips malformed rows, and
 * generates ids. Model JSON output is unreliable — this never throws.
 */
export function parseHintCandidates(raw: string): PronunciationCandidate[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const arr = Array.isArray((parsed as { candidates?: unknown })?.candidates)
    ? (parsed as { candidates: unknown[] }).candidates
    : Array.isArray(parsed)
      ? parsed
      : []
  const out: PronunciationCandidate[] = []
  for (const c of arr) {
    if (!c || typeof c !== 'object') continue
    const row = c as Record<string, unknown>
    const find = String(row.find ?? '').trim()
    const replace = String(row.replace ?? '').trim()
    if (!find || !replace) continue
    out.push({
      id: crypto.randomUUID(),
      find,
      replace,
      confidence: clamp01(row.confidence),
      category: asCategory(row.category),
    })
  }
  return out
}
