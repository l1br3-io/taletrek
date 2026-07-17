import { describe, expect, it } from 'vitest'
import {
  buildHintsMessages,
  buildTransformMessages,
  PARAGRAPH_DELIMITER,
  parseHintCandidates,
  splitOutput,
} from './prompts'
import { type TransformDefinition, transformDefId } from './types'

function makeDef(overrides: Partial<TransformDefinition> = {}): TransformDefinition {
  return {
    id: transformDefId('test-1'),
    label: 'Test',
    hint: '',
    desc: '',
    systemPrompt: 'Repair text. Return one paragraph.',
    params: [],
    ...overrides,
  }
}

describe('buildTransformMessages', () => {
  it('cleanup: OCR-cleaning system prompt + joined user paragraphs', () => {
    const def = makeDef({
      systemPrompt: 'Fix OCR errors in this text. Return one paragraph per input paragraph.',
    })
    const { system, user } = buildTransformMessages(def, {}, ['one', 'two'])
    expect(system).toMatch(/OCR/)
    expect(user).toBe(`one${PARAGRAPH_DELIMITER}two`)
  })

  it('translate: interpolates the target language from params', () => {
    const def = makeDef({
      systemPrompt: 'Translate to {{lang}}. Return one paragraph per input paragraph.',
      params: [{ key: 'lang', type: 'text', label: 'Target language', default: 'es' }],
    })
    const { system } = buildTransformMessages(def, { lang: 'fr' }, ['x'])
    expect(system).toMatch(/fr/)
  })

  it('summarize: interpolates ratio param', () => {
    const def = makeDef({
      systemPrompt: 'Summarise to {{ratio}} ratio.',
      params: [{ key: 'ratio', type: 'range', label: 'Ratio', default: 0.5 }],
    })
    const { system } = buildTransformMessages(def, { ratio: 0.3 }, ['x'])
    expect(system).toMatch(/0.3/)
  })

  it('simplify: interpolates level param with a default', () => {
    const def = makeDef({
      systemPrompt: 'Simplify to grade {{level}}.',
      params: [{ key: 'level', type: 'range', label: 'Grade', default: 2 }],
    })
    const { system } = buildTransformMessages(def, {}, ['x'])
    expect(system).toMatch(/2/)
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
