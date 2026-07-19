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

  describe('concurrency > 1 (ADR-0011 parallel synthesis)', () => {
    /**
     * Engine that resolves each synth on a deterministic schedule, where the
     * Nth dispatch resolves after `delays[i]` ticks — letting the test force
     * out-of-order completion. `delays` length must equal the number of
     * dispatches the test expects.
     */
    function makeScheduledEngine(delays: number[]): TtsEngine & { calls: SynthesisRequest[] } {
      const calls: SynthesisRequest[] = []
      return {
        async listVoices() {
          return []
        },
        isStored: async () => true,
        async download() {},
        async synthesize(req: SynthesisRequest): Promise<SynthesisResult> {
          calls.push(req)
          const i = calls.length - 1
          const delay = delays[i] ?? 0
          // Use a real setTimeout so Promise.race observes ordering.
          await new Promise<void>((resolve) => setTimeout(resolve, delay))
          return {
            audio: new Blob(['x']),
            synthMs: 100,
            durationSeconds: i + 1,
            cacheKey: `flat-${i}`,
          }
        },
        async remove() {},
        async clearAllStored() {},
        calls,
      }
    }

    it('keeps paragraphs[i] aligned with flat position when completions are out-of-order', async () => {
      // Six paragraphs, three workers. Delays make completion order [2,0,1,4,3,5]
      // — never the dispatch order. The result paragraphs[] must still be in
      // flat order.
      const chapters = makeChapters([['p0.', 'p1.', 'p2.', 'p3.', 'p4.', 'p5.']])
      const delays = [50, 30, 0, 60, 20, 10]
      const engine = makeScheduledEngine(delays)
      const result = await preSynthesizeBook({
        bookId: newBookId(),
        chapters,
        voiceId: 'en_US-hfc_female-medium' as VoiceId,
        engine,
        concurrency: 3,
      })
      expect(result.cancelled).toBe(false)
      expect(result.total).toBe(6)
      // The decisive assertion: paragraphs[i].cacheKey matches dispatch order
      // (= flat order), not completion order.
      expect(result.paragraphs.map((p) => p.cacheKey)).toEqual([
        'flat-0',
        'flat-1',
        'flat-2',
        'flat-3',
        'flat-4',
        'flat-5',
      ])
    })

    it('onProgress is monotonic and carries the completed paragraph location', async () => {
      const chapters = makeChapters([['p0.', 'p1.', 'p2.', 'p3.']])
      // Delays make completion order non-dispatch.
      const engine = makeScheduledEngine([40, 0, 20, 10])
      const events: Array<{ done: number; chapterIdx?: number; paraInChapter?: number }> = []
      await preSynthesizeBook({
        bookId: newBookId(),
        chapters,
        voiceId: 'en_US-hfc_female-medium' as VoiceId,
        engine,
        concurrency: 2,
        onProgress: (done, _total, completed) => {
          events.push({
            done,
            chapterIdx: completed?.chapterIndex,
            paraInChapter: completed?.paragraphInChapter,
          })
        },
      })
      // `done` must be strictly increasing (1, 2, 3, 4) regardless of which
      // paragraph completed in what order.
      expect(events.map((e) => e.done)).toEqual([1, 2, 3, 4])
      // `completed` always carries a real location.
      expect(events.every((e) => e.chapterIdx === 0 && typeof e.paraInChapter === 'number')).toBe(
        true,
      )
    })

    it('concurrency=1 preserves bit-for-bit sequential behaviour', async () => {
      // Sanity: the new loop with the default degenerates to the old one.
      const chapters = makeChapters([['a.', 'b.', 'c.']])
      const engine = makeStubEngine({})
      const progress: number[] = []
      const starts: number[] = []
      await preSynthesizeBook({
        bookId: newBookId(),
        chapters,
        voiceId: 'en_US-hfc_female-medium' as VoiceId,
        engine,
        concurrency: 1,
        onProgress: (done) => progress.push(done),
        onParagraphStart: (info) => starts.push(info.flatIndex),
      })
      expect(progress).toEqual([1, 2, 3])
      expect(starts).toEqual([0, 1, 2])
    })

    it('stops dispatching on abort; in-flight results land in the cache (no error)', async () => {
      // With concurrency=3 and abort mid-flight, the loop stops dispatching
      // new paragraphs but drains the in-flight window without throwing.
      const chapters = makeChapters([['p0.', 'p1.', 'p2.', 'p3.', 'p4.']])
      const controller = new AbortController()
      let callCount = 0
      const engine: TtsEngine = {
        ...makeStubEngine({}),
        async synthesize(): Promise<SynthesisResult> {
          callCount++
          const i = callCount - 1
          // Make p1 take long enough that the abort fires while it's in flight.
          await new Promise<void>((resolve) => setTimeout(resolve, i === 1 ? 50 : 0))
          return {
            audio: new Blob(['x']),
            synthMs: 100,
            durationSeconds: i + 1,
            cacheKey: `k${i}`,
          }
        },
      }
      const result = await preSynthesizeBook({
        bookId: newBookId(),
        chapters,
        voiceId: 'en_US-hfc_female-medium' as VoiceId,
        engine,
        concurrency: 3,
        signal: controller.signal,
        onProgress: (done) => {
          // Abort as soon as the first paragraph completes.
          if (done === 1) controller.abort()
        },
      })
      expect(result.cancelled).toBe(true)
      // We dispatched at least 3 (the initial window) but no more after abort.
      expect(callCount).toBeGreaterThanOrEqual(1)
      expect(callCount).toBeLessThanOrEqual(3)
    })
  })
})
