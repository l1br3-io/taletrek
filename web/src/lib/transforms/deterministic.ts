/**
 * Deterministic (non-AI) per-paragraph transforms. No engine, no network —
 * pure string functions. Surfaced alongside AI transforms in the per-paragraph
 * menu (M6 extension). Count-preserving: always returns exactly one paragraph.
 */

export type CaseMode = 'upper' | 'lower' | 'title' | 'sentence'

export type DeterministicOp =
  | { kind: 'case'; mode: CaseMode }
  | { kind: 'normalize' }
  | {
      kind: 'findReplace'
      find: string
      replace: string
      ignoreCase: boolean
      wholeWord: boolean
    }

/** Uppercase the entire string. */
function toUpperCase(text: string): string {
  return text.toUpperCase()
}

/** Lowercase the entire string. */
function toLowerCase(text: string): string {
  return text.toLowerCase()
}

/** Capitalize the first letter of every word. */
function toTitleCase(text: string): string {
  return text.replace(/\p{L}[\p{L}'']*/gu, (word) => {
    const [first, ...rest] = word
    return (first ?? '').toUpperCase() + rest.join('')
  })
}

/** Capitalize the first letter of each sentence. */
function toSentenceCase(text: string): string {
  const lower = text.toLowerCase()
  let out = ''
  let capitalizeNext = true
  for (let i = 0; i < lower.length; i++) {
    const ch = lower[i]
    if (capitalizeNext && ch !== undefined && /\p{L}/u.test(ch)) {
      out += ch.toUpperCase()
      capitalizeNext = false
    } else {
      out += ch ?? ''
      if (ch === '.' || ch === '!' || ch === '?' || ch === '\n') capitalizeNext = true
    }
  }
  return out
}

export function caseTransform(text: string, mode: CaseMode): string {
  switch (mode) {
    case 'upper':
      return toUpperCase(text)
    case 'lower':
      return toLowerCase(text)
    case 'title':
      return toTitleCase(text)
    case 'sentence':
      return toSentenceCase(text)
  }
}

/**
 * Whitespace + quote normalization for TTS: rejoins soft-hyphenated line
 * breaks (`glimmer-\ning` → `glimmering`), collapses whitespace runs to a
 * single space, trims, and normalizes smart quotes/apostrophes to ASCII.
 */
export function normalizeWhitespace(text: string): string {
  let out = text
  // Rejoin a lowercase letter + hyphen + line break + lowercase letter
  // (scanned-book hard line breaks inside a word).
  out = out.replace(/(\p{Ll})-\r?\n(\p{Ll})/gu, '$1$2')
  // Smart single/double quotes + apostrophes → ASCII.
  out = out.replace(/[\u2018\u2019\u201A\u201B]/g, "'").replace(/[\u201C\u201D\u201E\u201F]/g, '"')
  // Collapse any run of whitespace to a single space.
  out = out.replace(/\s+/g, ' ').trim()
  return out
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Find-and-replace within a paragraph. Complements the global pronunciation
 * dictionary with a one-off, paragraph-scoped substitution.
 */
export function findReplace(
  text: string,
  find: string,
  replace: string,
  opts: { ignoreCase?: boolean; wholeWord?: boolean } = {},
): string {
  if (!find) return text
  const { ignoreCase = false, wholeWord = false } = opts
  let pattern = escapeRegex(find)
  if (wholeWord) pattern = `\\b${pattern}\\b`
  const re = new RegExp(pattern, `g${ignoreCase ? 'i' : ''}u`)
  return text.replace(re, replace)
}

/** Apply a deterministic op to a single paragraph. */
export function applyDeterministicOp(text: string, op: DeterministicOp): string {
  switch (op.kind) {
    case 'case':
      return caseTransform(text, op.mode)
    case 'normalize':
      return normalizeWhitespace(text)
    case 'findReplace':
      return findReplace(text, op.find, op.replace, {
        ignoreCase: op.ignoreCase,
        wholeWord: op.wholeWord,
      })
  }
}
