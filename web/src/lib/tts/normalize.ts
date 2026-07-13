/**
 * Normalize text for speech synthesis. Piper relies on espeak-ng for
 * phonemization, which can emit malformed phoneme sequences for certain
 * Unicode punctuation and PDF-extraction artifacts — producing rushed or
 * garbled audio on some voice models. This runs in the TTS worker right
 * before `predict()`, so the reader still displays the original (cleaned)
 * text while the synthesizer receives something it can handle reliably.
 */
export function normalizeForSpeech(text: string): string {
  let out = text
  // Smart single/double quotes + apostrophes → ASCII.
  out = out.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
  out = out.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
  // Unicode hyphens/dashes (U+2010 HYPHEN … U+2015 HORIZONTAL BAR) → ASCII '-'.
  out = out.replace(/[\u2010-\u2015]/g, '-')
  // Rejoin words broken by an end-of-line hyphen that the PDF parser turned
  // into "frag- ment" (a lowercase letter on both sides ⇒ a split word, not a
  // real spaced compound). Mirrors the dehyphenation heuristic used elsewhere,
  // but matches the post-parse space instead of the original newline.
  out = out.replace(/(\p{Ll})- (\p{Ll})/gu, '$1$2')
  // Drop empty parentheses left by URL/image stripping, e.g. "titles ( ).".
  out = out.replace(/\(\s*\)/g, '')
  // Collapse runs of whitespace to a single space.
  out = out.replace(/\s+/g, ' ').trim()
  return out
}
