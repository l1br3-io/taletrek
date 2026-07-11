import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TtsEngine } from '../lib/tts/types'
import { bookId, type Chapter, type ChapterId, chapterId, type VoiceId, voiceId } from '../types'
import { type AudioController, useParagraphPlayer } from './useParagraphPlayer'

const VOICE = voiceId('en_US-hfc_female-medium')

function makeChapters(paragraphs: string[]): Chapter[] {
  return [
    {
      id: chapterId('c1') as ChapterId,
      bookId: bookId('b1'),
      index: 0,
      title: 'Ch1',
      paragraphs,
    },
  ]
}

/** A fake audio controller that records calls and lets tests trigger `ended`. */
class FakeAudio implements AudioController {
  loadedSrcs: string[] = []
  playCount = 0
  pausedCount = 0
  stoppedCount = 0
  rates: number[] = []
  private endedHandler: (() => void) | null = null
  private playShouldThrow = false

  async loadAndPlay(src: string): Promise<void> {
    this.loadedSrcs.push(src)
    if (this.playShouldThrow) throw new Error('play blocked')
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

function renderPlayer(paragraphs: string[], opts?: { engine?: TtsEngine; audio?: FakeAudio }) {
  const engine = opts?.engine ?? stubEngine()
  const audio = opts?.audio ?? new FakeAudio()
  const result = renderHook(
    (args: {
      chapters: Chapter[]
      voiceId: VoiceId
      rate: number
      engine: TtsEngine
      audio: AudioController
    }) =>
      useParagraphPlayer({
        chapters: args.chapters,
        voiceId: args.voiceId,
        playbackRate: args.rate,
        engine: args.engine,
        audio: args.audio,
      }),
    {
      initialProps: {
        chapters: makeChapters(paragraphs),
        voiceId: VOICE,
        rate: 1,
        engine,
        audio,
      },
    },
  )
  return { ...result, audio }
}

describe('useParagraphPlayer', () => {
  it('flattens chapters into stable paragraph ids', () => {
    const { result } = renderPlayer(['One.', 'Two.', 'Three.'])
    expect(result.current.currentParagraphId).toBeNull()
    expect(result.current.status.type).toBe('idle')
  })

  it('play synthesizes the first paragraph and enters playing state', async () => {
    const engine = stubEngine()
    const { result, audio } = renderPlayer(['Hello.', 'World.'], { engine })
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
    const { result, audio } = renderPlayer(['One.', 'Two.', 'Three.'], { engine })
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
    const { result, audio } = renderPlayer(['Only.'])
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
    const { result, audio } = renderPlayer(['Hello.'], { engine })
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
    expect(engine.calls.length).toBe(callsBefore) // no new synth
    expect(audio.playCount).toBeGreaterThan(0)
  })

  it('stop resets to idle at the start', async () => {
    const { result } = renderPlayer(['One.', 'Two.'])
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
    const { result } = renderPlayer(['A.', 'B.', 'C.', 'D.'], { engine })
    await act(async () => {
      result.current.seekToParagraph(`${chapterId('c1')}:2`)
    })
    expect(result.current.currentParagraphId).toBe(`${chapterId('c1')}:2`)
    expect(engine.calls.map((c) => c.text)).toEqual(['C.'])
  })

  it('next and prev move the pointer', async () => {
    const engine = stubEngine()
    const { result } = renderPlayer(['A.', 'B.', 'C.'], { engine })
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
    const { result } = renderPlayer(['A.', 'B.'])
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
    // Make the first synth slow; the second resolves first.
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
    const { result, audio } = renderPlayer(['A.', 'B.'], { engine })
    await act(async () => {
      result.current.play() // starts slow synth of A
    })
    await act(async () => {
      result.current.seekToParagraph(`${chapterId('c1')}:1`) // supersede with B
    })
    expect(result.current.currentParagraphId).toBe(`${chapterId('c1')}:1`)
    expect(audio.loadedSrcs).toEqual([expect.any(String)]) // only B's URL loaded
    // Now resolve the stale A synth — must be ignored (no second load).
    await act(async () => {
      resolveFirst({ audio: new Blob([new Uint8Array([9])]), synthMs: 9 })
    })
    expect(audio.loadedSrcs).toHaveLength(1)
    expect(result.current.currentParagraphId).toBe(`${chapterId('c1')}:1`)
  })

  it('revokes the previous Blob URL on every advance', async () => {
    const { result, audio } = renderPlayer(['A.', 'B.'])
    await act(async () => {
      result.current.play()
    })
    expect(audio.loadedSrcs).toHaveLength(1)
    expect(revokeSpy).not.toHaveBeenCalled()
    await act(async () => {
      audio.emitEnded() // advance to B
    })
    expect(revokeSpy).toHaveBeenCalledTimes(1)
    expect(audio.loadedSrcs).toHaveLength(2)
  })

  it('revokes the Blob URL on stop', async () => {
    const { result } = renderPlayer(['A.'])
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
    const { result } = renderPlayer(['A.'], { engine })
    await act(async () => {
      result.current.play()
    })
    expect(result.current.status).toEqual({ type: 'error', message: 'model missing' })
  })

  it('applies playbackRate to the audio controller', async () => {
    const audio = new FakeAudio()
    const { rerender } = renderPlayer(['A.'], { audio })
    expect(audio.rates).toContain(1)
    rerender({
      chapters: makeChapters(['A.']),
      voiceId: VOICE,
      rate: 1.5,
      engine: stubEngine(),
      audio,
    })
    expect(audio.rates).toContain(1.5)
  })
})
