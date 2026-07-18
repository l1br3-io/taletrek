/**
 * Normalize text for speech synthesis. Piper relies on espeak-ng for
 * phonemization, which can emit malformed phoneme sequences for certain
 * Unicode punctuation and PDF-extraction artifacts — producing rushed or
 * garbled audio on some voice models. This runs in the TTS worker right
 * before `predict()`, so the reader still displays the original (cleaned)
 * text while the synthesizer receives something it can handle reliably.
 */

/**
 * Version tag for the audio cache key (M8). Bump this when the normalization
 * logic above changes — old cache entries will miss on next synth and be
 * reaped by LRU. The cache key shape is
 * `${voiceId}:${NORM_VERSION}:${sha256(normalizedText)}`.
 *
 * v2: strips lone surrogates. PDF text extraction (pdfjs) can emit lone
 * UTF-16 surrogate code units (U+D800–U+DFFF unpaired) for certain glyph
 * mappings. `JSON.stringify` keeps them as `\uD800` escapes, which the C++
 * `nlohmann::json` parser inside `piper_phonemize.wasm` rejects as a
 * `parse_error` — the C++ exception aborts `main()` before any stdout, so
 * `predict()`'s outer promise never resolves and the synth hangs until our
 * 90s timeout kills the whole book upload. Stripping them at the boundary
 * is the surgical fix (verified empirically against the real WASM).
 */
export const NORM_VERSION = '2'

/**
 * Match a lone (unpaired) UTF-16 surrogate code unit. Valid surrogate *pairs*
 * (e.g. emoji) are preserved — only orphans are stripped. Two alternatives
 * cover both halves: a high surrogate not followed by a low one, and a low
 * surrogate not preceded by a high one.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

export function normalizeForSpeech(text: string): string {
  let out = text
  // Strip lone surrogates left by PDF text extraction (see NORM_VERSION v2
  // note above). Must run before `JSON.stringify` in `predict()`, which is
  // where the unpaired surrogate would otherwise reach the C++ JSON parser.
  out = out.replace(LONE_SURROGATE, '')
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

/**
 * Maximum chars fed to a single Piper inference call. Long paragraphs (common
 * artifact of PDF extraction — pdfjs merges visual paragraphs when the source
 * lacks blank-line separation) produce correspondingly long phoneme sequences,
 * and the ONNX VITS inference allocates tensors that scale with phoneme count.
 * On iOS Safari's worker, a 1700+ char paragraph can OOM-kill the worker
 * (silent — no error event, the promise just never resolves and the parent
 * tab eventually crashes/reloads under the memory pressure).
 *
 * 400 chars ≈ ~70 words ≈ ~240 phonemes per chunk — comfortably under any
 * reasonable mobile memory budget while keeping the per-call synth time at
 * ~2-4s. The reader still treats the paragraph as one unit; chunking is
 * engine-internal and the resulting WAVs are concatenated back together.
 */
export const MAX_SYNTH_CHARS = 400

/**
 * Split `text` into chunks small enough for a single Piper inference call.
 * Splits on sentence terminators first (preserves natural prosody — VITS
 * generates intonation per-chunk, so splitting at sentence boundaries keeps
 * each chunk self-contained); hard-splits at word boundaries only when a
 * single sentence exceeds `maxChars` (rare — usually a PDF artifact).
 *
 * Each returned chunk is trimmed; empty chunks are dropped. Trailing sentence
 * terminators stay with their sentence ("Hello. World!" → ["Hello. ", "World!"]).
 *
 * This is the input-side mirror of `concatWavBlobs` — they're paired: split
 * before synth, concat after. The cache key is derived from the FULL normalized
 * text (not per-chunk), so cache hits skip the chunking entirely on subsequent
 * requests for the same paragraph.
 */
export function splitForSpeech(text: string, maxChars = MAX_SYNTH_CHARS): string[] {
  if (text.length <= maxChars) return [text]

  const chunks: string[] = []
  let buf = ''

  // Sentence boundary: any run of non-terminators, then one or more
  // terminators (. ! ?), then trailing whitespace (or end of string).
  // Captures the terminator WITH the sentence so prosody stays natural.
  const sentences = text.match(/[^.!?]*[.!?]+(?:\s+|$)|[^.!?]+$/g) ?? [text]

  const flush = (): void => {
    const trimmed = buf.trim()
    if (trimmed) chunks.push(trimmed)
    buf = ''
  }

  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      // Single sentence exceeds the cap (PDF artifact: missing paragraph
      // break). Flush the accumulator, then hard-split this sentence at word
      // boundaries. Keep word+whitespace tokens together so we don't lose
      // spacing.
      flush()
      const tokens = sentence.split(/(\s+)/)
      let line = ''
      for (const token of tokens) {
        if ((line + token).length > maxChars && line.trim()) {
          chunks.push(line.trim())
          line = token.trimStart()
        } else {
          line += token
        }
      }
      if (line.trim()) buf = line
      continue
    }
    // Normal path: accumulate sentences until the next would exceed the cap.
    if ((buf + sentence).length > maxChars && buf.trim()) {
      flush()
    }
    buf += sentence
  }
  flush()

  return chunks
}
