import { describe, expect, it } from 'vitest'
import { normalizeForSpeech } from './normalize'

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
