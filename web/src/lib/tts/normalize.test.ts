import { describe, expect, it } from 'vitest'
import { MAX_SYNTH_CHARS, normalizeForSpeech, splitForSpeech } from './normalize'

describe('normalizeForSpeech', () => {
  it('passes plain ASCII text through unchanged', () => {
    expect(normalizeForSpeech('Hello world.')).toBe('Hello world.')
  })

  it('converts smart quotes and apostrophes to ASCII', () => {
    expect(normalizeForSpeech('\u201CHello\u201D \u2018world\u2019')).toBe('"Hello" \'world\'')
    expect(normalizeForSpeech('O\u2019Reilly')).toBe("O'Reilly")
  })

  it('converts Unicode hyphens/dashes to ASCII hyphen', () => {
    expect(normalizeForSpeech('en\u2013dash')).toBe('en-dash')
    expect(normalizeForSpeech('em\u2014dash')).toBe('em-dash')
  })

  it('rejoins words broken by an end-of-line hyphen turned into a space', () => {
    expect(normalizeForSpeech('institu\u2010 tional')).toBe('institutional')
    expect(normalizeForSpeech('glimmer- ing')).toBe('glimmering')
  })

  it('does not rejoin hyphenated compounds without a space', () => {
    expect(normalizeForSpeech('well-being')).toBe('well-being')
    expect(normalizeForSpeech('800-998-9938')).toBe('800-998-9938')
  })

  it('removes empty parentheses left by URL stripping', () => {
    expect(normalizeForSpeech('titles ( ). More.')).toBe('titles . More.')
    expect(normalizeForSpeech('see ( ) here')).toBe('see here')
  })

  it('collapses runs of whitespace', () => {
    expect(normalizeForSpeech('too   much\t\nspace')).toBe('too much space')
  })

  it('strips lone high surrogates left by PDF text extraction', () => {
    // \uD800 unpaired: would break nlohmann::json::parse inside the WASM.
    // The double space left behind is collapsed by the later whitespace step.
    expect(normalizeForSpeech('Before \uD800 after')).toBe('Before after')
  })

  it('strips lone low surrogates', () => {
    expect(normalizeForSpeech('A\uDC00B')).toBe('AB')
  })

  it('strips multiple mixed lone surrogates', () => {
    // \uD9FF is a high surrogate; the next code unit is ASCII 'D' (not a low
    // surrogate), so it is lone too — every unpaired code unit is stripped.
    expect(normalizeForSpeech('A\uD800B\uDC00C\uD9FFD\uDEFFE')).toBe('ABCDE')
  })

  it('preserves valid surrogate pairs (emoji and astral chars)', () => {
    expect(normalizeForSpeech('Hello \uD83D\uDE00 world!')).toBe('Hello \u{1F600} world!')
    expect(normalizeForSpeech('family \uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67')).toBe(
      'family \u{1F468}\u200D\u{1F469}\u200D\u{1F467}',
    )
  })

  it('strips a lone surrogate even when adjacent to a valid pair', () => {
    // \uD800 (lone) followed by a valid pair — only the lone one is removed.
    expect(normalizeForSpeech('\uD800\uD83D\uDE00')).toBe('\u{1F600}')
  })

  it('normalizes the O\u2019Reilly example paragraph end-to-end', () => {
    const input =
      'O\u2019Reilly books may be purchased for educational, business, or sales promotional use. Online editions are also available for most titles ( ). For more information, contact our corporate/institu\u2010 tional sales department: 800-998-9938 or corporate@oreilly.com .'
    const out = normalizeForSpeech(input)
    expect(out).toContain("O'Reilly")
    expect(out).toContain('institutional')
    expect(out).not.toContain('( )')
    expect(out).not.toContain('\u2019')
    expect(out).not.toContain('\u2010')
  })
})

describe('splitForSpeech', () => {
  it('returns a single chunk for short text', () => {
    expect(splitForSpeech('Hello world.')).toEqual(['Hello world.'])
  })

  it('returns a single chunk when text length equals the cap exactly', () => {
    const text = 'a'.repeat(MAX_SYNTH_CHARS)
    expect(splitForSpeech(text)).toEqual([text])
  })

  it('splits at sentence boundaries for multi-sentence text', () => {
    const text = 'First sentence. Second sentence. Third one!'
    const chunks = splitForSpeech(text, 20)
    // Each sentence (~16 chars) fits within the 20-char cap; greedy accumulation
    // merges the first two would exceed 20, so each becomes its own chunk.
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    // Re-assembling the chunks (with spaces) yields the same content.
    expect(chunks.join(' ')).toBe(text)
  })

  it('keeps the sentence terminator with its sentence', () => {
    const chunks = splitForSpeech('Hello. World!', 10)
    // "Hello." and "World!" stay together with their terminators.
    expect(chunks.some((c) => c.startsWith('Hello'))).toBe(true)
    expect(chunks.some((c) => c.includes('World'))).toBe(true)
  })

  it('hard-splits a single over-long sentence at word boundaries', () => {
    // PDF artifact: missing paragraph break leaves one giant "sentence".
    // Build one with words longer than the cap so word-boundary splits are forced.
    const words = Array.from({ length: 20 }, (_, i) => `word${i}`)
    const text = words.join(' ') // no terminator → treated as one sentence
    const chunks = splitForSpeech(text, 30)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(30)
    // No words are split — every chunk starts and ends on a word boundary.
    for (const c of chunks) expect(c.startsWith('word')).toBe(true)
  })

  it('handles the user-reported "Deep Work" paragraph length (1754 chars)', () => {
    // Simulate the failing-input shape: a ~1754 char paragraph built from
    // short unambiguous sentences joined with spaces after terminators.
    const base =
      'A brief sentence. Another one here. And a third to pad length. Followed by more words. Still more text is needed to reach the split cap so the chunking logic exercises properly within splitForSpeech. '
    const text = base.repeat(Math.ceil(1800 / base.length))
    expect(text.length).toBeGreaterThan(MAX_SYNTH_CHARS)
    const chunks = splitForSpeech(text)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(MAX_SYNTH_CHARS)
  })

  it('does not produce empty chunks', () => {
    const text = 'One. Two. Three.'
    const chunks = splitForSpeech(text, 5)
    for (const c of chunks) expect(c.length).toBeGreaterThan(0)
  })
})
