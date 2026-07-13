import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TtsEngine } from '../lib/tts/types'
import { bookId, type Chapter, type ChapterId, chapterId, type VoiceId, voiceId } from '../types'
import { type AudioController, useParagraphPlayer } from './useParagraphPlayer'

const VOICE = voiceId('en_US-hfc_female-medium')
const VOICE_2 = voiceId('en_US-amy-medium')

function makeChapters(paragraphsByChapter: { title: string; paragraphs: string[] }[]): Chapter[] {
  return paragraphsByChapter.map((c, index) => ({
    id: chapterId(`c${index + 1}`) as ChapterId,
    bookId: bookId('b1'),
    index,
    title: c.title,
    paragraphs: c.paragraphs,
  }))
}

function oneChapter(paragraphs: string[]): Chapter[] {
  return makeChapters([{ title: 'Ch1', paragraphs }])
}

/** A fake audio controller that records calls and lets tests trigger `ended`. */
class FakeAudio implements AudioController {
  loadedSrcs: string[] = []
  playCount = 0
  pausedCount = 0
  stoppedCount = 0
  rates: number[] = []
  seekByCalls: number[] = []
  seekToCalls: number[] = []
  private endedHandler: (() => void) | null = null
  private playShouldThrow = false
  private _currentTime = 0
  private _duration = 0
  /** When set, the next `loadAndPlay` fires a spurious `ended` mid-swap. */
  fireEndedOnLoad = false

  async loadAndPlay(src: string): Promise<void> {
    this.loadedSrcs.push(src)
    if (this.playShouldThrow) throw new Error('play blocked')
    if (this.fireEndedOnLoad) {
      this.fireEndedOnLoad = false
      this.endedHandler?.()
    }
  }
  async resume(): Promise<void> {
    this.playCount++
  }
  pause(): void {
    this.pausedCount++
  }
  stop(): void {
    this.stoppedCount++
  }
  setPlaybackRate(rate: number): void {
    this.rates.push(rate)
  }
  onEnded(handler: () => void): () => void {
    this.endedHandler = handler
    return () => {
      this.endedHandler = null
    }
  }
  emitEnded(): void {
    this.endedHandler?.()
  }
  throwOnNextPlay(): void {
    this.playShouldThrow = true
  }
  seekBy(delta: number): void {
    this.seekByCalls.push(delta)
  }
  seekTo(seconds: number): void {
    this.seekToCalls.push(seconds)
  }
  get currentTime(): number {
    return this._currentTime
  }
  get duration(): number {
    return this._duration
  }
  setPosition(currentTime: number, duration = 0): void {
    this._currentTime = currentTime
    this._duration = duration
  }
}

/** A stub TtsEngine that resolves a distinct WAV per call and records calls. */
function stubEngine(): TtsEngine & { calls: { text: string; voiceId: VoiceId }[] } {
  const calls: { text: string; voiceId: VoiceId }[] = []
  let n = 0
  return {
    calls,
    async listVoices() {
      return []
    },
    async isStored() {
      return false
    },
    async download() {},
    async remove() {},
    async synthesize(req) {
      calls.push({ text: req.text, voiceId: req.voiceId })
      n++
      return { audio: new Blob([new Uint8Array([n])], { type: 'audio/x-wav' }), synthMs: n }
    },
  }
}

let revokeSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  revokeSpy = vi.spyOn(URL, 'revokeObjectURL')
})

afterEach(() => {
  revokeSpy.mockRestore()
})

interface RenderOpts {
  engine?: TtsEngine
  audio?: FakeAudio
  lookahead?: number
  voiceId?: VoiceId
}

function renderPlayer(chapters: Chapter[], opts?: RenderOpts) {
  const engine = opts?.engine ?? stubEngine()
  const audio = opts?.audio ?? new FakeAudio()
  const result = renderHook(
    (args: {
      chapters: Chapter[]
      voiceId: VoiceId
      rate: number
      engine: TtsEngine
      audio: AudioController
      lookahead: number
    }) =>
      useParagraphPlayer({
        chapters: args.chapters,
        voiceId: args.voiceId,
        playbackRate: args.rate,
        engine: args.engine,
        audio: args.audio,
        lookahead: args.lookahead,
      }),
    {
      initialProps: {
        chapters,
        voiceId: opts?.voiceId ?? VOICE,
        rate: 1,
        engine,
        audio,
        lookahead: opts?.lookahead ?? 0,
      },
    },
  )
  return { ...result, audio }
}

// Behavioral tests run at lookahead=0 (no pre-rendering) so pointer, advance,
// revocation, and cancellation semantics are isolated from the queue.
describe('useParagraphPlayer — playback (lookahead=0)', () => {
  it('flattens chapters into stable paragraph ids', () => {
    const { result } = renderPlayer(oneChapter(['One.', 'Two.', 'Three.']))
    expect(result.current.currentParagraphId).toBeNull()
    expect(result.current.status.type).toBe('idle')
  })

  it('play synthesizes the first paragraph and enters playing state', async () => {
    const engine = stubEngine()
    const { result, audio } = renderPlayer(oneChapter(['Hello.', 'World.']), { engine })
    await act(async () => {
      result.current.play()
    })
    expect(engine.calls).toHaveLength(1)
    expect(result.current.status.type).toBe('playing')
    expect(result.current.currentParagraphId).toBe(`${chapterId('c1')}:0`)
    expect(audio.loadedSrcs).toHaveLength(1)
  })

  it('auto-advances to the next paragraph on ended', async () => {
    const engine = stubEngine()
    const { result, audio } = renderPlayer(oneChapter(['One.', 'Two.', 'Three.']), { engine })
    await act(async () => {
      result.current.play()
    })
    expect(result.current.currentParagraphId).toBe(`${chapterId('c1')}:0`)
    await act(async () => {
      audio.emitEnded()
    })
    expect(result.current.currentParagraphId).toBe(`${chapterId('c1')}:1`)
    expect(result.current.status.type).toBe('playing')
    expect(engine.calls.map((c) => c.text)).toEqual(['One.', 'Two.'])
  })

  it('enters ended state after the last paragraph', async () => {
    const { result, audio } = renderPlayer(oneChapter(['Only.']))
    await act(async () => {
      result.current.play()
    })
    await act(async () => {
      audio.emitEnded()
    })
    expect(result.current.status.type).toBe('ended')
  })

  it('pause then play resumes without re-synthesizing', async () => {
    const engine = stubEngine()
    const { result, audio } = renderPlayer(oneChapter(['Hello.']), { engine })
    await act(async () => {
      result.current.play()
    })
    const callsBefore = engine.calls.length
    await act(async () => {
      result.current.pause()
    })
    expect(result.current.status.type).toBe('paused')
    await act(async () => {
      result.current.play()
    })
    expect(result.current.status.type).toBe('playing')
    expect(engine.calls.length).toBe(callsBefore)
    expect(audio.playCount).toBeGreaterThan(0)
  })

  it('stop resets to idle at the start', async () => {
    const { result } = renderPlayer(oneChapter(['One.', 'Two.']))
    await act(async () => {
      result.current.play()
    })
    await act(async () => {
      result.current.stop()
    })
    expect(result.current.status.type).toBe('idle')
    expect(result.current.currentParagraphId).toBeNull()
  })

  it('seekToParagraph jumps to the chosen paragraph', async () => {
    const engine = stubEngine()
    const { result } = renderPlayer(oneChapter(['A.', 'B.', 'C.', 'D.']), { engine })
    await act(async () => {
      result.current.seekToParagraph(`${chapterId('c1')}:2`)
    })
    expect(result.current.currentParagraphId).toBe(`${chapterId('c1')}:2`)
    expect(engine.calls.map((c) => c.text)).toEqual(['C.'])
  })

  it('next and prev move the pointer', async () => {
    const engine = stubEngine()
    const { result } = renderPlayer(oneChapter(['A.', 'B.', 'C.']), { engine })
    await act(async () => {
      result.current.play()
    })
    await act(async () => {
      result.current.next()
    })
    expect(result.current.currentParagraphId).toBe(`${chapterId('c1')}:1`)
    await act(async () => {
      result.current.prev()
    })
    expect(result.current.currentParagraphId).toBe(`${chapterId('c1')}:0`)
    expect(engine.calls.map((c) => c.text)).toEqual(['A.', 'B.', 'A.'])
  })

  it('prev clamps at the first paragraph', async () => {
    const { result } = renderPlayer(oneChapter(['A.', 'B.']))
    await act(async () => {
      result.current.play()
    })
    await act(async () => {
      result.current.prev()
    })
    expect(result.current.currentParagraphId).toBe(`${chapterId('c1')}:0`)
  })

  it('cancels a stale synthesis when a newer request supersedes it', async () => {
    const engine = stubEngine()
    let resolveFirst: (v: { audio: Blob; synthMs: number }) => void
    const slowSynth = new Promise<{ audio: Blob; synthMs: number }>((r) => {
      resolveFirst = r
    })
    const originalSynthesize = engine.synthesize.bind(engine)
    let firstCall = true
    engine.synthesize = async (req) => {
      if (firstCall) {
        firstCall = false
        return slowSynth
      }
      return originalSynthesize(req)
    }
    const { result, audio } = renderPlayer(oneChapter(['A.', 'B.']), { engine })
    await act(async () => {
      result.current.play()
    })
    await act(async () => {
      result.current.seekToParagraph(`${chapterId('c1')}:1`)
    })
    expect(result.current.currentParagraphId).toBe(`${chapterId('c1')}:1`)
    expect(audio.loadedSrcs).toEqual([expect.any(String)])
    await act(async () => {
      resolveFirst({ audio: new Blob([new Uint8Array([9])]), synthMs: 9 })
    })
    expect(audio.loadedSrcs).toHaveLength(1)
    expect(result.current.currentParagraphId).toBe(`${chapterId('c1')}:1`)
  })

  it('revokes the previous Blob URL on every advance', async () => {
    const { result, audio } = renderPlayer(oneChapter(['A.', 'B.']))
    await act(async () => {
      result.current.play()
    })
    expect(audio.loadedSrcs).toHaveLength(1)
    expect(revokeSpy).not.toHaveBeenCalled()
    await act(async () => {
      audio.emitEnded()
    })
    expect(revokeSpy).toHaveBeenCalledTimes(1)
    expect(audio.loadedSrcs).toHaveLength(2)
  })

  it('revokes the Blob URL on stop', async () => {
    const { result } = renderPlayer(oneChapter(['A.']))
    await act(async () => {
      result.current.play()
    })
    expect(revokeSpy).not.toHaveBeenCalled()
    await act(async () => {
      result.current.stop()
    })
    expect(revokeSpy).toHaveBeenCalledTimes(1)
  })

  it('surfaces a synthesis error in the status', async () => {
    const engine = stubEngine()
    engine.synthesize = async () => {
      throw new Error('model missing')
    }
    const { result } = renderPlayer(oneChapter(['A.']), { engine })
    await act(async () => {
      result.current.play()
    })
    expect(result.current.status).toEqual({ type: 'error', message: 'model missing' })
  })

  it('applies playbackRate to the audio controller', async () => {
    const audio = new FakeAudio()
    const { rerender } = renderPlayer(oneChapter(['A.']), { audio })
    expect(audio.rates).toContain(1)
    rerender({
      chapters: oneChapter(['A.']),
      voiceId: VOICE,
      rate: 1.5,
      engine: stubEngine(),
      audio,
      lookahead: 0,
    })
    expect(audio.rates).toContain(1.5)
  })

  it('seekBy / seekTo / getAudioPosition delegate to the audio controller', async () => {
    const audio = new FakeAudio()
    audio.setPosition(12, 40)
    const { result } = renderPlayer(oneChapter(['A.']), { audio })
    await act(async () => {
      result.current.play()
    })
    result.current.seekBy(-15)
    result.current.seekTo(5)
    expect(audio.seekByCalls).toEqual([-15])
    expect(audio.seekToCalls).toEqual([5])
    expect(result.current.getAudioPosition()).toEqual({ currentTime: 12, duration: 40 })
  })
})

// Pre-render queue tests at lookahead=3 (production default).
describe('useParagraphPlayer — pre-render queue (lookahead=3)', () => {
  it('pre-renders ahead after the current paragraph plays', async () => {
    const engine = stubEngine()
    const { result } = renderPlayer(oneChapter(['One.', 'Two.', 'Three.', 'Four.']), {
      engine,
      lookahead: 3,
    })
    await act(async () => {
      result.current.play()
    })
    await waitFor(() => {
      expect(engine.calls.map((c) => c.text)).toEqual(['One.', 'Two.', 'Three.', 'Four.'])
    })
    expect(result.current.status.type).toBe('playing')
    expect(result.current.currentParagraphId).toBe(`${chapterId('c1')}:0`)
    expect(result.current.bufferedAhead).toBe(3)
  })

  it('advances gaplessly from the buffer on ended (no new synth)', async () => {
    const engine = stubEngine()
    const { result, audio } = renderPlayer(oneChapter(['One.', 'Two.', 'Three.']), {
      engine,
      lookahead: 3,
    })
    await act(async () => {
      result.current.play()
    })
    await waitFor(() => {
      expect(engine.calls).toHaveLength(3)
    })
    const callsBeforeEnded = engine.calls.length
    await act(async () => {
      audio.emitEnded()
    })
    expect(result.current.currentParagraphId).toBe(`${chapterId('c1')}:1`)
    expect(result.current.status.type).toBe('playing')
    expect(engine.calls.length).toBe(callsBeforeEnded)
  })

  it('ignores a spurious ended fired during a buffered advance', async () => {
    const audio = new FakeAudio()
    const { result } = renderPlayer(oneChapter(['A.', 'B.', 'C.']), { audio, lookahead: 3 })
    await act(async () => {
      result.current.play()
    })
    await waitFor(() => {
      expect(result.current.bufferedAhead).toBeGreaterThan(0)
    })
    // The next advance pulls para1 from the buffer; simulate a spurious `ended`
    // firing during that src swap (as browsers can on src changes). Without the
    // in-flight guard this skips para1 and jumps straight to para2.
    audio.fireEndedOnLoad = true
    await act(async () => {
      audio.emitEnded()
    })
    expect(result.current.currentParagraphId).toBe(`${chapterId('c1')}:1`)
    expect(audio.loadedSrcs).toHaveLength(2)
  })

  it('caps look-ahead at the configured depth (back-pressure)', async () => {
    const engine = stubEngine()
    const { result } = renderPlayer(oneChapter(['A.', 'B.', 'C.', 'D.', 'E.', 'F.']), {
      engine,
      lookahead: 3,
    })
    await act(async () => {
      result.current.play()
    })
    await waitFor(() => {
      expect(engine.calls).toHaveLength(4)
    })
    expect(engine.calls.length).toBe(4)
    expect(result.current.bufferedAhead).toBe(3)
  })

  it('invalidates and re-primes on a discontinuous seek', async () => {
    const engine = stubEngine()
    const { result } = renderPlayer(oneChapter(['A.', 'B.', 'C.', 'D.', 'E.']), {
      engine,
      lookahead: 3,
    })
    await act(async () => {
      result.current.play()
    })
    await waitFor(() => {
      expect(engine.calls).toHaveLength(4)
    })
    await act(async () => {
      result.current.seekToParagraph(`${chapterId('c1')}:4`)
    })
    expect(result.current.currentParagraphId).toBe(`${chapterId('c1')}:4`)
    await waitFor(() => {
      expect(engine.calls.map((c) => c.text)).toContain('E.')
    })
  })

  it('revokes the live Blob URL on every advance (queue active)', async () => {
    const { result, audio } = renderPlayer(oneChapter(['A.', 'B.', 'C.']), { lookahead: 3 })
    await act(async () => {
      result.current.play()
    })
    await waitFor(() => {
      expect(audio.loadedSrcs).toHaveLength(1)
    })
    expect(revokeSpy).not.toHaveBeenCalled()
    await act(async () => {
      audio.emitEnded()
    })
    expect(revokeSpy).toHaveBeenCalledTimes(1)
  })

  it('clears the buffer on stop', async () => {
    const engine = stubEngine()
    const { result } = renderPlayer(oneChapter(['A.', 'B.', 'C.']), { engine, lookahead: 3 })
    await act(async () => {
      result.current.play()
    })
    await waitFor(() => {
      expect(result.current.bufferedAhead).toBe(2)
    })
    await act(async () => {
      result.current.stop()
    })
    expect(result.current.status.type).toBe('idle')
    expect(result.current.bufferedAhead).toBe(0)
  })

  it('invalidates the buffer when the voice changes', async () => {
    const engine = stubEngine()
    const { result, rerender } = renderPlayer(oneChapter(['A.', 'B.', 'C.']), {
      engine,
      lookahead: 3,
      voiceId: VOICE,
    })
    await act(async () => {
      result.current.play()
    })
    await waitFor(() => {
      expect(result.current.bufferedAhead).toBe(2)
    })
    rerender({
      chapters: oneChapter(['A.', 'B.', 'C.']),
      voiceId: VOICE_2,
      rate: 1,
      engine,
      audio: new FakeAudio(),
      lookahead: 3,
    })
    await waitFor(() => {
      expect(result.current.bufferedAhead).toBe(0)
    })
  })

  it('invalidates the buffer when the chapters reference changes', async () => {
    const engine = stubEngine()
    const audio = new FakeAudio()
    const { result, rerender } = renderPlayer(oneChapter(['A.', 'B.', 'C.']), {
      engine,
      audio,
      lookahead: 3,
    })
    await act(async () => {
      result.current.play()
    })
    await waitFor(() => {
      expect(result.current.bufferedAhead).toBe(2)
    })
    rerender({
      chapters: oneChapter(['A-clean.', 'B-clean.', 'C-clean.']),
      voiceId: VOICE,
      rate: 1,
      engine,
      audio,
      lookahead: 3,
    })
    await waitFor(() => {
      expect(result.current.bufferedAhead).toBe(0)
    })
  })
})

// Chapter-skip tests (multi-chapter books).
describe('useParagraphPlayer — chapter skip', () => {
  const book = makeChapters([
    { title: 'Ch1', paragraphs: ['1a.', '1b.'] },
    { title: 'Ch2', paragraphs: ['2a.', '2b.'] },
    { title: 'Ch3', paragraphs: ['3a.', '3b.'] },
  ])

  it('nextChapter jumps to the first paragraph of the next chapter', async () => {
    const engine = stubEngine()
    const { result } = renderPlayer(book, { engine, lookahead: 0 })
    await act(async () => {
      result.current.play()
    })
    expect(result.current.currentParagraphId).toBe(`${chapterId('c1')}:0`)
    await act(async () => {
      result.current.nextChapter()
    })
    expect(result.current.currentParagraphId).toBe(`${chapterId('c2')}:0`)
    await act(async () => {
      result.current.nextChapter()
    })
    expect(result.current.currentParagraphId).toBe(`${chapterId('c3')}:0`)
  })

  it('prevChapter jumps to the first paragraph of the previous chapter', async () => {
    const engine = stubEngine()
    const { result } = renderPlayer(book, { engine, lookahead: 0 })
    await act(async () => {
      result.current.seekToParagraph(`${chapterId('c3')}:1`)
    })
    await act(async () => {
      result.current.prevChapter()
    })
    expect(result.current.currentParagraphId).toBe(`${chapterId('c2')}:0`)
  })

  it('nextChapter is a no-op on the last chapter', async () => {
    const engine = stubEngine()
    const { result } = renderPlayer(book, { engine, lookahead: 0 })
    await act(async () => {
      result.current.seekToParagraph(`${chapterId('c3')}:0`)
    })
    await act(async () => {
      result.current.nextChapter()
    })
    expect(result.current.currentParagraphId).toBe(`${chapterId('c3')}:0`)
  })
})

// Resume + position-output tests (M5).
describe('useParagraphPlayer — resume + position outputs', () => {
  it('seeds the pointer from initialIndex without playing', () => {
    const { result } = renderHook(() =>
      useParagraphPlayer({
        chapters: oneChapter(['A.', 'B.', 'C.', 'D.']),
        voiceId: VOICE,
        playbackRate: 1,
        engine: stubEngine(),
        audio: new FakeAudio(),
        lookahead: 0,
        initialIndex: 2,
      }),
    )
    expect(result.current.status.type).toBe('idle')
    expect(result.current.currentIndex).toBe(2)
    expect(result.current.currentParagraphId).toBe(`${chapterId('c1')}:2`)
    expect(result.current.currentParagraph?.text).toBe('C.')
  })

  it('currentIndex/currentParagraph are null when idle', () => {
    const { result } = renderHook(() =>
      useParagraphPlayer({
        chapters: oneChapter(['A.', 'B.']),
        voiceId: VOICE,
        playbackRate: 1,
        engine: stubEngine(),
        audio: new FakeAudio(),
        lookahead: 0,
      }),
    )
    expect(result.current.currentIndex).toBeNull()
    expect(result.current.currentParagraph).toBeNull()
  })

  it('currentIndex tracks the pointer through play and advance', async () => {
    const engine = stubEngine()
    const audio = new FakeAudio()
    const { result } = renderHook(() =>
      useParagraphPlayer({
        chapters: oneChapter(['A.', 'B.', 'C.']),
        voiceId: VOICE,
        playbackRate: 1,
        engine,
        audio,
        lookahead: 0,
      }),
    )
    await act(async () => {
      result.current.play()
    })
    expect(result.current.currentIndex).toBe(0)
    await act(async () => {
      audio.emitEnded()
    })
    expect(result.current.currentIndex).toBe(1)
    expect(result.current.currentParagraph?.text).toBe('B.')
  })
})
