import { describe, expect, it, vi } from 'vitest'
import type { Chapter, VoiceId } from '../types'
import { newBookId, newChapterId } from '../types'
import { PreSynthError, preSynthesizeBook } from './pre-synth'
import type { SynthesisRequest, SynthesisResult, TtsEngine, Voice } from './tts/types'

function makeChapters(paragraphs: string[][]): Chapter[] {
  const bId = newBookId()
  return paragraphs.map((paras, index) => ({
    id: newChapterId(),
    bookId: bId,
    index,
    title: `Chapter ${index + 1}`,
    paragraphs: paras,
  }))
}

function makeStubEngine(opts: {
  isStored?: boolean
  synthResults?: SynthesisResult[]
}): TtsEngine & { synthCalls: SynthesisRequest[] } {
  const synthCalls: SynthesisRequest[] = []
  let callIdx = 0
  return {
    async listVoices(): Promise<Voice[]> {
      return []
    },
    isStored: async () => opts.isStored ?? true,
    async download() {},
    async synthesize(req: SynthesisRequest): Promise<SynthesisResult> {
      synthCalls.push(req)
      const result = opts.synthResults?.[callIdx] ?? {
        audio: new Blob(['x']),
        synthMs: 100,
        durationSeconds: 1,
        cacheKey: 'k',
      }
      callIdx++
      return result
    },
    async remove() {},
    async clearAllStored() {},
    synthCalls,
  }
}

describe('preSynthesizeBook', () => {
  it('synthesizes all non-empty paragraphs sequentially', async () => {
    const chapters = makeChapters([
      ['Hello world.', 'Second paragraph.', ''],
      ['Chapter two text.'],
    ])
    const engine = makeStubEngine({})
    const result = await preSynthesizeBook({
      bookId: newBookId(),
      chapters,
      voiceId: 'en_US-hfc_female-medium' as VoiceId,
      engine,
    })
    expect(result.total).toBe(3)
    expect(result.synthesized).toBe(3)
    expect(result.cached).toBe(0)
    expect(result.cancelled).toBe(false)
    expect(engine.synthCalls).toHaveLength(3)
  })

  it('reports progress after each paragraph', async () => {
    const chapters = makeChapters([['A.', 'B.', 'C.']])
    const engine = makeStubEngine({})
    const progress: Array<{ done: number; total: number }> = []
    await preSynthesizeBook({
      bookId: newBookId(),
      chapters,
      voiceId: 'en_US-hfc_female-medium' as VoiceId,
      engine,
      onProgress: (done, total) => progress.push({ done, total }),
    })
    expect(progress).toEqual([
      { done: 1, total: 3 },
      { done: 2, total: 3 },
      { done: 3, total: 3 },
    ])
  })

  it('counts cache hits (synthMs === 0) as cached, not synthesized', async () => {
    const chapters = makeChapters([['A.', 'B.']])
    const engine = makeStubEngine({
      synthResults: [
        { audio: new Blob(['x']), synthMs: 0, durationSeconds: 1, cacheKey: 'a' },
        { audio: new Blob(['y']), synthMs: 500, durationSeconds: 1, cacheKey: 'b' },
      ],
    })
    const result = await preSynthesizeBook({
      bookId: newBookId(),
      chapters,
      voiceId: 'en_US-hfc_female-medium' as VoiceId,
      engine,
    })
    expect(result.cached).toBe(1)
    expect(result.synthesized).toBe(1)
  })

  it('downloads the voice when not stored', async () => {
    const chapters = makeChapters([['A.']])
    const downloadSpy = vi.fn()
    const engine = makeStubEngine({ isStored: false })
    engine.download = downloadSpy
    await preSynthesizeBook({
      bookId: newBookId(),
      chapters,
      voiceId: 'en_US-hfc_female-medium' as VoiceId,
      engine,
    })
    expect(downloadSpy).toHaveBeenCalledOnce()
  })

  it('does not download the voice when already stored', async () => {
    const chapters = makeChapters([['A.']])
    const downloadSpy = vi.fn()
    const engine = makeStubEngine({ isStored: true })
    engine.download = downloadSpy
    await preSynthesizeBook({
      bookId: newBookId(),
      chapters,
      voiceId: 'en_US-hfc_female-medium' as VoiceId,
      engine,
    })
    expect(downloadSpy).not.toHaveBeenCalled()
  })

  it('forwards voice download progress', async () => {
    const chapters = makeChapters([['A.']])
    const fractions: number[] = []
    const engine = makeStubEngine({ isStored: false })
    engine.download = async (_id, cb) => {
      cb?.(0.5)
      cb?.(1)
    }
    await preSynthesizeBook({
      bookId: newBookId(),
      chapters,
      voiceId: 'en_US-hfc_female-medium' as VoiceId,
      engine,
      onVoiceDownload: (f) => fractions.push(f),
    })
    expect(fractions).toEqual([0.5, 1])
  })

  it('stops early when the abort signal fires', async () => {
    const chapters = makeChapters([['A.', 'B.', 'C.', 'D.']])
    const engine = makeStubEngine({})
    const controller = new AbortController()
    const result = await preSynthesizeBook({
      bookId: newBookId(),
      chapters,
      voiceId: 'en_US-hfc_female-medium' as VoiceId,
      engine,
      onProgress: (done) => {
        if (done === 2) controller.abort()
      },
      signal: controller.signal,
    })
    expect(result.cancelled).toBe(true)
    expect(result.synthesized + result.cached).toBe(2)
    expect(engine.synthCalls).toHaveLength(2)
  })

  it('skips paragraphs that are empty or whitespace-only', async () => {
    const chapters = makeChapters([['A.', '   ', '', 'B.']])
    const engine = makeStubEngine({})
    const result = await preSynthesizeBook({
      bookId: newBookId(),
      chapters,
      voiceId: 'en_US-hfc_female-medium' as VoiceId,
      engine,
    })
    expect(result.total).toBe(2)
    expect(engine.synthCalls).toHaveLength(2)
    expect(engine.synthCalls[0]?.text).toBe('A.')
    expect(engine.synthCalls[1]?.text).toBe('B.')
  })

  it('aborts with TimeoutError when a synth exceeds the per-request deadline', async () => {
    vi.useFakeTimers()
    try {
      const chapters = makeChapters([['A.']])
      // Synth that never resolves — simulates iOS Safari freezing the worker
      // under memory pressure (no event fires on the main thread).
      const stalledEngine: TtsEngine = {
        ...makeStubEngine({}),
        async synthesize(): Promise<SynthesisResult> {
          return new Promise(() => {})
        },
      }
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const pending = preSynthesizeBook({
        bookId: newBookId(),
        chapters,
        voiceId: 'en_US-hfc_female-medium' as VoiceId,
        engine: stalledEngine,
      })
      // Attach the rejection handler BEFORE advancing the timer — otherwise
      // Node flags it as an unhandled rejection in the gap between the
      // setTimeout firing and the test's `await expect(...).rejects` line.
      const captured = pending.catch((e: unknown) => e)
      // SYNTH_TIMEOUT_MS is private to the module — fast-forward past 90s.
      await vi.advanceTimersByTimeAsync(91_000)
      const err = await captured
      // The synth timeout DOMException is wrapped in a PreSynthError so the
      // message identifies which paragraph stalled — but the original
      // TimeoutError is preserved as `cause`.
      expect(err).toBeInstanceOf(PreSynthError)
      const wrappedErr = err as PreSynthError
      expect(wrappedErr.cause).toBeInstanceOf(DOMException)
      expect((wrappedErr.cause as DOMException).name).toBe('TimeoutError')
      expect(wrappedErr.message).toContain('TimeoutError')
      errSpy.mockRestore()
    } finally {
      vi.useRealTimers()
    }
  })

  it('propagates the underlying error on the first synth failure, wrapped with location', async () => {
    // Engine fails on the second call of three — exercises both the
    // "first failure hard-fails" contract and the location annotation.
    const chapters = makeChapters([['A.', 'B.', 'C.'], ['D.']])
    let n = 0
    const failingEngine: TtsEngine = {
      ...makeStubEngine({}),
      async synthesize(): Promise<SynthesisResult> {
        n++
        if (n === 2) {
          // Realistic failure: the vendored session throws a PiperError-shaped
          // object (we don't import the real class here to keep the test
          // decoupled from the vendor module).
          throw Object.assign(
            new Error('phonemize: no phoneme output (main aborted before stdout)'),
            {
              name: 'PiperError',
              phase: 'phonemize',
            },
          )
        }
        return {
          audio: new Blob(['x']),
          synthMs: 100,
          durationSeconds: 1,
          cacheKey: `k${n}`,
        }
      },
    }
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const promise = preSynthesizeBook({
      bookId: newBookId(),
      chapters,
      voiceId: 'en_US-hfc_female-medium' as VoiceId,
      engine: failingEngine,
    })
    await expect(promise).rejects.toBeInstanceOf(PreSynthError)
    try {
      await promise
    } catch (e) {
      const err = e as PreSynthError
      // Identifies the failing paragraph: chapter 1, paragraph 2 of 3, ¶ 2 of 4 overall.
      expect(err.location.chapterIndex).toBe(0)
      expect(err.location.chapterTitle).toBe('Chapter 1')
      expect(err.location.paragraphInChapter).toBe(2)
      expect(err.location.chapterTotal).toBe(3)
      expect(err.flatIndex).toBe(1)
      expect(err.flatTotal).toBe(4)
      expect(err.textPreview).toBe('B.')
      expect(err.message).toContain("chapter 1 'Chapter 1'")
      expect(err.message).toContain('paragraph 2/3')
      expect(err.message).toContain('¶ 2/4 overall')
      expect(err.message).toContain('phonemize:')
      // The original cause is preserved for callers that want to switch on phase.
      expect((err.cause as { phase?: string }).phase).toBe('phonemize')
    }
    // Should have attempted exactly 2 synths — we hard-fail on first error
    // rather than grinding through the rest of the book.
    expect(n).toBe(2)
    expect(errSpy).toHaveBeenCalledWith(
      '[taletrek] pre-synth: synth failed',
      expect.objectContaining({
        errName: 'PiperError',
        errPhase: 'phonemize',
        chapterIndex: 0,
        paragraphInChapter: 2,
        chapterTotal: 3,
        index: 1,
      }),
    )
    errSpy.mockRestore()
  })
})
