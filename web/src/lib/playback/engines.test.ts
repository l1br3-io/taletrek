import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  _resetEngineSupportCacheForTests,
  ENGINE_PREFERENCE,
  type EngineCapability,
  ffmpegSupported,
  MOBILE_ENGINES,
  type PlaybackEngineSetting,
  resolveMobileEngine,
  webAudioSupported,
} from './engines'

afterEach(() => {
  vi.restoreAllMocks()
  _resetEngineSupportCacheForTests()
})

/** Build a synthetic capability set for the resolution matrix. */
function caps(webAudio: boolean, ffmpeg: boolean): EngineCapability[] {
  return [
    { id: 'web-audio', label: '', description: '', supported: () => webAudio },
    { id: 'ffmpeg', label: '', description: '', supported: () => ffmpeg },
  ]
}

describe('webAudioSupported', () => {
  it('is true when an AudioContext constructor is present', () => {
    expect(webAudioSupported(class {})).toBe(true)
    expect(webAudioSupported(function AudioContext() {})).toBe(true)
  })

  it('is false when no constructor is available', () => {
    expect(webAudioSupported(undefined)).toBe(false)
    expect(webAudioSupported(null)).toBe(false)
    expect(webAudioSupported({})).toBe(false)
  })
})

describe('ffmpegSupported', () => {
  it('requires both AAC-in-mp4 <video> support and OPFS', () => {
    expect(ffmpegSupported({ canPlayType: () => 'probably', hasOpfs: true })).toBe(true)
    expect(ffmpegSupported({ canPlayType: () => 'maybe', hasOpfs: true })).toBe(true)
    expect(ffmpegSupported({ canPlayType: () => '', hasOpfs: true })).toBe(false)
    expect(ffmpegSupported({ canPlayType: () => 'probably', hasOpfs: false })).toBe(false)
  })
})

describe('resolveMobileEngine', () => {
  describe("'auto'", () => {
    it.each([
      ['web-audio', true, true],
      ['web-audio', true, false],
      ['ffmpeg', false, true],
    ])('resolves to %s when supported (webAudio=%s, ffmpeg=%s)', (expected, wa, ff) => {
      expect(resolveMobileEngine('auto', caps(wa, ff))).toBe(expected)
    })

    it('falls back to web-audio when neither is supported', () => {
      expect(resolveMobileEngine('auto', caps(false, false))).toBe('web-audio')
    })

    it('prefers web-audio per ENGINE_PREFERENCE order', () => {
      expect(ENGINE_PREFERENCE[0]).toBe('web-audio')
    })
  })

  describe('explicit choice', () => {
    it.each([
      ['web-audio', 'web-audio'],
      ['ffmpeg', 'ffmpeg'],
    ])('honours %s when supported', (setting, expected) => {
      expect(resolveMobileEngine(setting as PlaybackEngineSetting, caps(true, true))).toBe(expected)
    })

    it('falls back to the other engine with a console.info when unsupported', () => {
      const spy = vi.spyOn(console, 'info').mockImplementation(() => {})
      expect(resolveMobileEngine('web-audio', caps(false, true))).toBe('ffmpeg')
      expect(resolveMobileEngine('ffmpeg', caps(true, false))).toBe('web-audio')
      expect(spy).toHaveBeenCalledTimes(2)
      expect(spy.mock.calls[0]?.[0]).toContain("'web-audio' not supported")
      expect(spy.mock.calls[1]?.[0]).toContain("'ffmpeg' not supported")
    })

    it('falls back to web-audio when an explicit choice is unsupported and so is the other', () => {
      const spy = vi.spyOn(console, 'info').mockImplementation(() => {})
      expect(resolveMobileEngine('ffmpeg', caps(false, false))).toBe('web-audio')
      // No supported fallback found → silent (the `'auto'` branch returns web-audio)
      expect(spy).not.toHaveBeenCalled()
    })
  })

  describe('production capability cache (iOS OOM regression — ADR-0010)', () => {
    it('probes the DOM at most once across many resolution calls (no per-render <video>)', () => {
      // `usePlayer` calls resolveMobileEngine on every render; during a long
      // synth the reader re-renders per paragraph. Per-render probing would
      // create hundreds of <video> elements and OOM iOS. Capabilities are
      // cached after the first probe.
      const createSpy = vi.spyOn(document, 'createElement')
      _resetEngineSupportCacheForTests()

      // Simulate a long synth: 200 re-renders.
      for (let i = 0; i < 200; i++) {
        resolveMobileEngine('auto', MOBILE_ENGINES)
      }

      // <video> is created at most once total (for the ffmpeg canPlayType probe).
      const videoCreates = createSpy.mock.calls.filter((a) => a[0] === 'video').length
      expect(videoCreates).toBeLessThanOrEqual(1)
    })
  })
})
