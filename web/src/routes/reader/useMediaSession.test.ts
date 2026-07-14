import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaSessionActionHandlers } from '../../lib/media-session'
import { bookId, type Chapter, type ChapterId, chapterId } from '../../types'
import type { MediaSessionPlayer } from './useMediaSession'
import { useMediaSession } from './useMediaSession'
import type { PlaybackStatus } from './useParagraphPlayer'

const holder = vi.hoisted(() => ({ handlers: null as MediaSessionActionHandlers | null }))
const media = vi.hoisted(() => {
  return {
    setMediaMetadata: vi.fn(),
    setMediaSessionHandlers: vi.fn((h: MediaSessionActionHandlers) => {
      holder.handlers = h
      return () => {}
    }),
    setMediaPlaybackState: vi.fn(),
    setMediaPositionState: vi.fn(),
    clearMediaSession: vi.fn(),
  }
})

vi.mock('../../lib/media-session', () => ({
  isMediaSessionSupported: () => true,
  setMediaMetadata: media.setMediaMetadata,
  setMediaSessionHandlers: media.setMediaSessionHandlers,
  setMediaPlaybackState: media.setMediaPlaybackState,
  setMediaPositionState: media.setMediaPositionState,
  clearMediaSession: media.clearMediaSession,
}))

function makeChapters(): Chapter[] {
  return [
    {
      id: chapterId('c1') as ChapterId,
      bookId: bookId('b1'),
      index: 0,
      title: 'Beginning',
      paragraphs: ['p0', 'p1'],
    },
    {
      id: chapterId('c2') as ChapterId,
      bookId: bookId('b1'),
      index: 1,
      title: 'Middle',
      paragraphs: ['p0'],
    },
  ]
}

function makePlayer(overrides?: Partial<MediaSessionPlayer>) {
  const calls: string[] = []
  const base: MediaSessionPlayer = {
    status: { type: 'idle' } as PlaybackStatus,
    currentParagraphId: null,
    play: () => calls.push('play'),
    pause: () => calls.push('pause'),
    nextChapter: () => calls.push('nextChapter'),
    prevChapter: () => calls.push('prevChapter'),
    seekBy: (d) => calls.push(`seekBy:${d}`),
    seekTo: (s) => calls.push(`seekTo:${s}`),
    getAudioPosition: () => ({ currentTime: 0, duration: 30 }),
  }
  return { player: { ...base, ...overrides }, calls }
}

function renderSession(opts: {
  player: MediaSessionPlayer
  bookTitle?: string
  chapters?: Chapter[]
  playbackRate?: number
}) {
  return renderHook(
    (args: {
      player: MediaSessionPlayer
      bookTitle: string
      chapters: Chapter[]
      playbackRate: number
    }) =>
      useMediaSession({
        player: args.player,
        bookTitle: args.bookTitle,
        chapters: args.chapters,
        playbackRate: args.playbackRate,
      }),
    {
      initialProps: {
        player: opts.player,
        bookTitle: opts.bookTitle ?? 'My Book',
        chapters: opts.chapters ?? makeChapters(),
        playbackRate: opts.playbackRate ?? 1,
      },
    },
  )
}

beforeEach(() => {
  media.setMediaMetadata.mockClear()
  media.setMediaSessionHandlers.mockClear()
  media.setMediaPlaybackState.mockClear()
  media.setMediaPositionState.mockClear()
  media.clearMediaSession.mockClear()
})

describe('useMediaSession — handler registration', () => {
  it('registers handlers once on mount and clears on unmount', () => {
    const { player } = makePlayer()
    const { unmount } = renderSession({ player })
    expect(media.setMediaSessionHandlers).toHaveBeenCalledTimes(1)
    expect(media.clearMediaSession).not.toHaveBeenCalled()
    unmount()
    expect(media.clearMediaSession).toHaveBeenCalledTimes(1)
  })

  it('does not re-register handlers across re-renders', () => {
    const { player } = makePlayer()
    const { rerender } = renderSession({ player })
    rerender({ player, bookTitle: 'My Book', chapters: makeChapters(), playbackRate: 1 })
    rerender({ player, bookTitle: 'My Book', chapters: makeChapters(), playbackRate: 1 })
    expect(media.setMediaSessionHandlers).toHaveBeenCalledTimes(1)
  })

  it('bound handlers invoke the latest player methods', () => {
    const { player, calls } = makePlayer()
    renderSession({ player })
    expect(holder.handlers).not.toBeNull()
    const handlers = holder.handlers as MediaSessionActionHandlers
    handlers.play()
    handlers.pause()
    handlers.seekbackward()
    handlers.seekforward()
    handlers.seekto(7.5)
    handlers.nexttrack()
    handlers.previoustrack()
    expect(calls).toEqual([
      'play',
      'pause',
      'seekBy:-15',
      'seekBy:15',
      'seekTo:7.5',
      'nextChapter',
      'prevChapter',
    ])
  })

  it('seekto ignores a null target time', () => {
    const { player, calls } = makePlayer()
    renderSession({ player })
    expect(holder.handlers).not.toBeNull()
    const handlers = holder.handlers as MediaSessionActionHandlers
    handlers.seekto(null)
    expect(calls).toEqual([])
  })
})

describe('useMediaSession — metadata', () => {
  it('sets metadata with the book title and first chapter on mount', () => {
    const { player } = makePlayer()
    renderSession({ player, bookTitle: 'Dune' })
    expect(media.setMediaMetadata).toHaveBeenCalledWith({
      title: 'Dune',
      artist: 'TaleTrek',
      album: 'Beginning',
      artworkUrl: '/icons/pwa-512.png',
    })
  })

  it('updates album to the current chapter when the paragraph changes', () => {
    const { player } = makePlayer()
    const { rerender } = renderSession({ player, bookTitle: 'Dune' })
    const chapters = makeChapters()
    media.setMediaMetadata.mockClear()
    rerender({
      player: { ...player, currentParagraphId: `${chapterId('c2')}:0` },
      bookTitle: 'Dune',
      chapters,
      playbackRate: 1,
    })
    expect(media.setMediaMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Dune', album: 'Middle' }),
    )
  })

  it('updates title when the book changes', () => {
    const { player } = makePlayer()
    const { rerender } = renderSession({ player, bookTitle: 'Old' })
    media.setMediaMetadata.mockClear()
    rerender({ player, bookTitle: 'New', chapters: makeChapters(), playbackRate: 1 })
    expect(media.setMediaMetadata).toHaveBeenCalledWith(expect.objectContaining({ title: 'New' }))
  })
})

describe('useMediaSession — playback & position state', () => {
  it('reflects playing → setMediaPlaybackState + setPositionState', () => {
    const { player } = makePlayer({
      status: { type: 'playing', paragraphId: 'x' },
      getAudioPosition: () => ({ currentTime: 3, duration: 40 }),
    })
    renderSession({ player, playbackRate: 1.5 })
    expect(media.setMediaPlaybackState).toHaveBeenCalledWith('playing')
    expect(media.setMediaPositionState).toHaveBeenCalledWith(40, 3, 1.5)
  })

  it('reflects paused state', () => {
    const { player } = makePlayer({ status: { type: 'paused', paragraphId: 'x' } })
    renderSession({ player })
    expect(media.setMediaPlaybackState).toHaveBeenCalledWith('paused')
  })

  it('reflects idle/ended/error as none', () => {
    const cases: PlaybackStatus[] = [
      { type: 'idle' },
      { type: 'ended' },
      { type: 'error', message: 'x' },
    ]
    for (const status of cases) {
      const { player } = makePlayer({ status })
      renderSession({ player })
    }
    expect(media.setMediaPlaybackState).toHaveBeenCalledWith('none')
  })

  it('does not change playback state while loading', () => {
    const { player } = makePlayer({ status: { type: 'loading' } })
    renderSession({ player })
    expect(media.setMediaPlaybackState).not.toHaveBeenCalled()
  })

  it('transitions state when status changes', async () => {
    const { player } = makePlayer({ status: { type: 'idle' } })
    const { rerender } = renderSession({ player })
    expect(media.setMediaPlaybackState).toHaveBeenLastCalledWith('none')
    rerender({
      player: { ...player, status: { type: 'playing', paragraphId: 'x' } },
      bookTitle: 'My Book',
      chapters: makeChapters(),
      playbackRate: 1,
    })
    expect(media.setMediaPlaybackState).toHaveBeenLastCalledWith('playing')
  })
})

describe('useMediaSession — refs stay current', () => {
  it('handlers invoke the player from the latest render, not the first', () => {
    const first = makePlayer()
    const second = makePlayer()
    const { rerender } = renderSession({ player: first.player })
    rerender({
      player: second.player,
      bookTitle: 'My Book',
      chapters: makeChapters(),
      playbackRate: 1,
    })
    expect(holder.handlers).not.toBeNull()
    const handlers = holder.handlers as MediaSessionActionHandlers
    handlers.play()
    expect(second.calls).toContain('play')
    expect(first.calls).not.toContain('play')
  })
})
