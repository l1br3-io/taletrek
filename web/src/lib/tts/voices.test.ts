import { describe, expect, it } from 'vitest'
import { voiceId } from '../../types'
import { CURATED_VOICES, DEFAULT_VOICE_ID, getVoice } from './voices'

describe('curated voice catalog', () => {
  it('contains 8 voices', () => {
    expect(CURATED_VOICES).toHaveLength(8)
  })

  it('every voice is English and medium quality', () => {
    for (const v of CURATED_VOICES) {
      expect(v.language).toMatch(/^en_/)
      expect(v.quality).toBe('medium')
    }
  })

  it('has unique ids', () => {
    const ids = CURATED_VOICES.map((v) => v.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every voice has a positive model size and a display name', () => {
    for (const v of CURATED_VOICES) {
      expect(v.sizeBytes).toBeGreaterThan(0)
      expect(v.name.length).toBeGreaterThan(0)
    }
  })

  it('includes both US and GB locales', () => {
    const locales = new Set(CURATED_VOICES.map((v) => v.language))
    expect(locales).toContain('en_US')
    expect(locales).toContain('en_GB')
  })

  it('default voice id is the spike-proven hfc_female', () => {
    expect(DEFAULT_VOICE_ID).toBe(voiceId('en_US-hfc_female-medium'))
  })

  it('default voice id is in the catalog', () => {
    expect(getVoice(DEFAULT_VOICE_ID)).toBeDefined()
    expect(getVoice(DEFAULT_VOICE_ID)?.name).toBe('HFC Female')
  })

  it('getVoice returns undefined for an unknown id', () => {
    expect(getVoice(voiceId('en_US-nobody-medium'))).toBeUndefined()
  })
})
