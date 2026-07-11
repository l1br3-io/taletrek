import { describe, expect, it } from 'vitest'
import { applyPronunciation } from './pronunciation'
import type { PronunciationEntry } from './types'

function entry(find: string, replace: string, id = find): PronunciationEntry {
  return { id, find, replace }
}

describe('applyPronunciation', () => {
  it('replaces a whole word', () => {
    expect(applyPronunciation('hello Siobhan!', [entry('Siobhan', 'shi-vawn')])).toBe(
      'hello shi-vawn!',
    )
  })

  it('is case-insensitive', () => {
    expect(applyPronunciation('SIOBHAN siobhan SiObHaN', [entry('Siobhan', 'shi-vawn')])).toBe(
      'shi-vawn shi-vawn shi-vawn',
    )
  })

  it('does not replace partial matches inside other words', () => {
    expect(applyPronunciation('misogyny contains "sis"', [entry('sis', 's-i-s')])).toBe(
      'misogyny contains "s-i-s"',
    )
  })

  it('applies multiple entries', () => {
    const out = applyPronunciation('foo and bar', [entry('foo', 'f-o-o'), entry('bar', 'b-a-r')])
    expect(out).toBe('f-o-o and b-a-r')
  })

  it('resolves overlapping entries by longest find first', () => {
    expect(
      applyPronunciation('C++ and C', [entry('C', 'see'), entry('C++', 'see-plus-plus')]),
    ).toBe('see-plus-plus and see')
  })

  it('escapes regex special characters in find', () => {
    expect(applyPronunciation('cost is $1 each', [entry('$1', 'one dollar')])).toBe(
      'cost is one dollar each',
    )
  })

  it('does not crash on a plus-plus find', () => {
    expect(() =>
      applyPronunciation('I love C++ today', [entry('C++', 'see plus plus')]),
    ).not.toThrow()
    expect(applyPronunciation('I love C++ today', [entry('C++', 'see plus plus')])).toBe(
      'I love see plus plus today',
    )
  })

  it('skips entries with an empty find', () => {
    expect(applyPronunciation('hello world', [entry('', 'nope'), entry('world', 'earth')])).toBe(
      'hello earth',
    )
  })

  it('returns text unchanged when no valid entries', () => {
    expect(applyPronunciation('untouched', [])).toBe('untouched')
  })

  it('preserves surrounding punctuation', () => {
    expect(applyPronunciation('(GIF) file.', [entry('GIF', 'jif')])).toBe('(jif) file.')
  })
})
