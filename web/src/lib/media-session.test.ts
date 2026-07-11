import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MediaMetadataInput, MediaSessionActionHandlers } from './media-session'
import {
  clearMediaSession,
  isMediaSessionSupported,
  setMediaMetadata,
  setMediaPlaybackState,
  setMediaPositionState,
  setMediaSessionHandlers,
} from './media-session'

type ActionHandler = ((details: { action: string; seekTime?: number | null }) => void) | null

interface FakeMediaSession {
  metadata: MediaMetadata | null
  playbackState: string
  handlers: Map<string, ActionHandler>
  setPositionStateCalled: { duration: number; position: number; playbackRate: number }[]
}

interface FakeMediaMetadata {
  title: string
  artist: string
  album: string
  artwork: { src: string; sizes: string; type: string }[]
}

let fake: FakeMediaSession
let originalMediaSession: PropertyDescriptor | undefined
let originalMediaMetadata: typeof globalThis.MediaMetadata | undefined

function installMediaSession(unsupported = false) {
  fake = {
    metadata: null,
    playbackState: 'none',
    handlers: new Map(),
    setPositionStateCalled: [],
  }
  const stub = {
    get metadata() {
      return fake.metadata
    },
    set metadata(v) {
      fake.metadata = v
    },
    get playbackState() {
      return fake.playbackState
    },
    set playbackState(v) {
      fake.playbackState = v
    },
    setActionHandler(action: string, handler: ActionHandler) {
      fake.handlers.set(action, handler)
    },
    setPositionState(state: { duration: number; position: number; playbackRate: number }) {
      fake.setPositionStateCalled.push(state)
    },
  }
  if (unsupported) {
    // Ensure `'mediaSession' in navigator` is false (delete, don't set undefined).
    // @ts-expect-error remove the prop entirely for the unsupported path
    delete (navigator as Record<string, unknown>).mediaSession
    return
  }
  Object.defineProperty(navigator, 'mediaSession', {
    value: stub,
    configurable: true,
    writable: true,
  })
}

beforeEach(() => {
  originalMediaMetadata = globalThis.MediaMetadata
  class FakeMediaMetadataImpl implements FakeMediaMetadata {
    title: string
    artist: string
    album: string
    artwork: { src: string; sizes: string; type: string }[]
    constructor(init: FakeMediaMetadata) {
      this.title = init.title
      this.artist = init.artist
      this.album = init.album
      this.artwork = init.artwork
    }
  }
  globalThis.MediaMetadata = FakeMediaMetadataImpl as unknown as typeof MediaMetadata
})

afterEach(() => {
  if (originalMediaSession) {
    Object.defineProperty(navigator, 'mediaSession', originalMediaSession)
  } else {
    // @ts-expect-error allow deletion of the test-installed prop
    delete (navigator as Record<string, unknown>).mediaSession
  }
  if (originalMediaMetadata === undefined) {
    // @ts-expect-error restore global
    delete globalThis.MediaMetadata
  } else {
    globalThis.MediaMetadata = originalMediaMetadata
  }
})

function sampleHandlers(): MediaSessionActionHandlers & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    play: () => calls.push('play'),
    pause: () => calls.push('pause'),
    seekbackward: () => calls.push('seekbackward'),
    seekforward: () => calls.push('seekforward'),
    seekto: (t) => calls.push(`seekto:${t}`),
    nexttrack: () => calls.push('nexttrack'),
    previoustrack: () => calls.push('previoustrack'),
  }
}

const SAMPLE_META: MediaMetadataInput = {
  title: 'The Book',
  artist: 'TaleTrek',
  album: 'Chapter 1',
  artworkUrl: '/icons/pwa-512.png',
}

describe('media-session — unsupported', () => {
  beforeEach(() => installMediaSession(true))

  it('isMediaSessionSupported returns false', () => {
    expect(isMediaSessionSupported()).toBe(false)
  })

  it('all setters are no-ops without throwing', () => {
    expect(() => {
      setMediaMetadata(SAMPLE_META)
      setMediaSessionHandlers(sampleHandlers())
      setMediaPlaybackState('playing')
      setMediaPositionState(10, 1, 1)
      clearMediaSession()
    }).not.toThrow()
  })

  it('setMediaSessionHandlers returns a cleanup that does not throw', () => {
    const cleanup = setMediaSessionHandlers(sampleHandlers())
    expect(() => cleanup()).not.toThrow()
  })
})

describe('media-session — metadata', () => {
  beforeEach(() => installMediaSession())

  it('constructs MediaMetadata with title/artist/album/artwork', () => {
    setMediaMetadata(SAMPLE_META)
    const meta = fake.metadata as unknown as FakeMediaMetadata
    expect(meta.title).toBe('The Book')
    expect(meta.artist).toBe('TaleTrek')
    expect(meta.album).toBe('Chapter 1')
    expect(meta.artwork).toEqual([
      { src: '/icons/pwa-512.png', sizes: '512x512', type: 'image/png' },
    ])
  })

  it('overwrites previous metadata on subsequent calls', () => {
    setMediaMetadata(SAMPLE_META)
    setMediaMetadata({ ...SAMPLE_META, album: 'Chapter 2' })
    expect((fake.metadata as unknown as FakeMediaMetadata).album).toBe('Chapter 2')
  })
})

describe('media-session — action handlers', () => {
  beforeEach(() => installMediaSession())

  it('registers all seven actions', () => {
    const cleanup = setMediaSessionHandlers(sampleHandlers())
    expect([...fake.handlers.keys()].sort()).toEqual([
      'nexttrack',
      'pause',
      'play',
      'previoustrack',
      'seekbackward',
      'seekforward',
      'seekto',
    ])
    cleanup()
  })

  it('invokes the bound callback when the OS fires an action', () => {
    const h = sampleHandlers()
    const cleanup = setMediaSessionHandlers(h)
    fake.handlers.get('play')?.({ action: 'play' })
    fake.handlers.get('nexttrack')?.({ action: 'nexttrack' })
    fake.handlers.get('seekto')?.({ action: 'seekto', seekTime: 4.5 })
    expect(h.calls).toEqual(['play', 'nexttrack', 'seekto:4.5'])
    cleanup()
  })

  it('seekto passes null when the OS omits seekTime', () => {
    const h = sampleHandlers()
    const cleanup = setMediaSessionHandlers(h)
    fake.handlers.get('seekto')?.({ action: 'seekto' })
    expect(h.calls).toEqual(['seekto:null'])
    cleanup()
  })

  it('cleanup de-registers all handlers', () => {
    const cleanup = setMediaSessionHandlers(sampleHandlers())
    cleanup()
    for (const action of fake.handlers.keys()) {
      expect(fake.handlers.get(action)).toBeNull()
    }
  })
})

describe('media-session — playback & position state', () => {
  beforeEach(() => installMediaSession())

  it('sets playbackState', () => {
    setMediaPlaybackState('playing')
    expect(fake.playbackState).toBe('playing')
    setMediaPlaybackState('paused')
    expect(fake.playbackState).toBe('paused')
    setMediaPlaybackState('none')
    expect(fake.playbackState).toBe('none')
  })

  it('setPositionState forwards valid state', () => {
    setMediaPositionState(40, 10, 1.5)
    expect(fake.setPositionStateCalled).toEqual([{ duration: 40, position: 10, playbackRate: 1.5 }])
  })

  it('setPositionState rejects invalid values (NaN/negative/out-of-range)', () => {
    setMediaPositionState(NaN, 0, 1)
    setMediaPositionState(0, 0, 1)
    setMediaPositionState(40, -1, 1)
    setMediaPositionState(40, 50, 1)
    setMediaPositionState(40, 10, 0)
    expect(fake.setPositionStateCalled).toHaveLength(0)
  })
})

describe('media-session — clear', () => {
  beforeEach(() => installMediaSession())

  it('clears metadata, handlers, and resets playback state', () => {
    setMediaMetadata(SAMPLE_META)
    setMediaSessionHandlers(sampleHandlers())
    setMediaPlaybackState('playing')
    clearMediaSession()
    expect(fake.metadata).toBeNull()
    for (const action of fake.handlers.keys()) {
      expect(fake.handlers.get(action)).toBeNull()
    }
    expect(fake.playbackState).toBe('none')
  })
})
