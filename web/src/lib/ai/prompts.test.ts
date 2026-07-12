import { describe, expect, it } from 'vitest'
import {
  buildHintsMessages,
  buildTransformMessages,
  PARAGRAPH_DELIMITER,
  parseHintCandidates,
  splitOutput,
} from './prompts'

describe('buildTransformMessages', () => {
  it('cleanup: OCR-cleaning system prompt + joined user paragraphs', () => {
    const { system, user } = buildTransformMessages({ kind: 'cleanup' }, ['one', 'two'])
    expect(system).toMatch(/OCR/)
    expect(user).toBe(`one${PARAGRAPH_DELIMITER}two`)
  })

  it('translate: includes the target language code', () => {
    const { system } = buildTransformMessages({ kind: 'translate', target: 'es' }, ['x'])
    expect(system).toMatch(/"es"/)
  })

  it('summarize: includes the ratio as a percentage', () => {
    const { system } = buildTransformMessages({ kind: 'summarize', ratio: 0.5 }, ['x'])
    expect(system).toMatch(/50%/)
  })

  it('simplify: includes the grade level', () => {
    const { system } = buildTransformMessages({ kind: 'simplify', level: 3 }, ['x'])
    expect(system).toMatch(/Grade 3/)
  })

  it('marks hints as JSON mode', () => {
    const { json, system } = buildHintsMessages(['x'])
    expect(json).toBe(true)
    expect(system).toMatch(/JSON object/)
  })
})

describe('splitOutput', () => {
  it('splits on blank lines, trims, drops empties', () => {
    expect(splitOutput('a\n\nb\n\n  c  \n\n\n')).toEqual(['a', 'b', 'c'])
  })

  it('returns a single trimmed paragraph for non-delimited text', () => {
    expect(splitOutput('just one')).toEqual(['just one'])
  })

  it('returns [] for blank/whitespace-only output', () => {
    expect(splitOutput('   \n\n  \n')).toEqual([])
  })

  it('preserves surrogate pairs within a paragraph', () => {
    expect(splitOutput('emoji 🗡️ here\n\nnext ✨')).toEqual(['emoji 🗡️ here', 'next ✨'])
  })
})

describe('parseHintCandidates', () => {
  it('parses {candidates:[...]} into typed candidates with ids', () => {
    const raw = JSON.stringify({
      candidates: [
        { find: 'Siobhan', replace: 'shi-vawn', confidence: 0.9, category: 'proper-noun' },
        { find: 'Eärendil', replace: 'eh-ren-dil', confidence: 0.8, category: 'neologism' },
      ],
    })
    const out = parseHintCandidates(raw)
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({
      find: 'Siobhan',
      replace: 'shi-vawn',
      confidence: 0.9,
      category: 'proper-noun',
    })
    expect(out[0]?.id).toEqual(expect.any(String))
  })

  it('accepts a bare array as the top-level shape', () => {
    const out = parseHintCandidates(JSON.stringify([{ find: 'x', replace: 'y' }]))
    expect(out).toHaveLength(1)
  })

  it('clamps confidence into [0,1] and defaults an unknown category to "other"', () => {
    const out = parseHintCandidates(
      JSON.stringify([{ find: 'a', replace: 'b', confidence: 5, category: 'made-up' }]),
    )
    expect(out[0]?.confidence).toBe(1)
    expect(out[0]?.category).toBe('other')
  })

  it('skips rows missing find or replace', () => {
    const out = parseHintCandidates(
      JSON.stringify([{ find: '', replace: 'x' }, { replace: 'y' }, { find: 'ok', replace: 'k' }]),
    )
    expect(out).toHaveLength(1)
    expect(out[0]?.find).toBe('ok')
  })

  it('returns [] on unparseable JSON without throwing', () => {
    expect(parseHintCandidates('not json')).toEqual([])
    expect(parseHintCandidates('')).toEqual([])
  })
})
