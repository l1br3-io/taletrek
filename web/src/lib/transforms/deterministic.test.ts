import { describe, expect, it } from 'vitest'
import {
  applyDeterministicOp,
  caseTransform,
  findReplace,
  normalizeWhitespace,
} from './deterministic'

describe('caseTransform', () => {
  it('upper-cases', () => {
    expect(caseTransform('Hello, World.', 'upper')).toBe('HELLO, WORLD.')
  })
  it('lower-cases', () => {
    expect(caseTransform('Hello, World.', 'lower')).toBe('hello, world.')
  })
  it('title-cases each word', () => {
    expect(caseTransform("the cat's pyjamas", 'title')).toBe("The Cat's Pyjamas")
  })
  it('sentence-cases the start of each sentence', () => {
    expect(caseTransform('hello. again? yes! ok', 'sentence')).toBe('Hello. Again? Yes! Ok')
  })
})

describe('normalizeWhitespace', () => {
  it('rejoins lowercase hyphenated line breaks', () => {
    expect(normalizeWhitespace('glimmer-\ning')).toBe('glimmering')
  })
  it('collapses whitespace runs and trims', () => {
    expect(normalizeWhitespace('  too   much   \n  space  ')).toBe('too much space')
  })
  it('normalizes smart quotes to ASCII', () => {
    expect(normalizeWhitespace('\u201chello\u201d \u2018it\u2019s')).toBe('"hello" \'it\'s')
  })
})

describe('findReplace', () => {
  it('replaces all occurrences', () => {
    expect(findReplace('cat and cat', 'cat', 'dog')).toBe('dog and dog')
  })
  it('honors ignoreCase', () => {
    expect(findReplace('Cat CAT cat', 'cat', 'dog', { ignoreCase: true })).toBe('dog dog dog')
  })
  it('honors wholeWord', () => {
    expect(findReplace('the theorem there', 'the', 'a', { wholeWord: true })).toBe(
      'a theorem there',
    )
  })
  it('escapes regex special characters in find', () => {
    expect(findReplace('1.5 + 2', '+', '-')).toBe('1.5 - 2')
  })
  it('is a no-op when find is empty', () => {
    expect(findReplace('unchanged', '', 'x')).toBe('unchanged')
  })
})

describe('applyDeterministicOp', () => {
  it('applies a case op', () => {
    expect(applyDeterministicOp('hi', { kind: 'case', mode: 'upper' })).toBe('HI')
  })
  it('applies a normalize op', () => {
    expect(applyDeterministicOp('a   b', { kind: 'normalize' })).toBe('a b')
  })
  it('applies a findReplace op', () => {
    expect(
      applyDeterministicOp('cat', {
        kind: 'findReplace',
        find: 'cat',
        replace: 'dog',
        ignoreCase: false,
        wholeWord: false,
      }),
    ).toBe('dog')
  })
})
