import { describe, expect, it, vi } from 'vitest'
import type { Chapter, VoiceId } from '../types'
import { newBookId, newChapterId } from '../types'
import { preSynthesizeBook } from './pre-synth'
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
      const result = opts.synthResults?.[callIdx] ?? { audio: new Blob(['x']), synthMs: 100 }
      callIdx++
      return result
    },
    async remove() {},
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
        { audio: new Blob(['x']), synthMs: 0 },
        { audio: new Blob(['y']), synthMs: 500 },
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

  it('stops early when isCancelled returns true', async () => {
    const chapters = makeChapters([['A.', 'B.', 'C.', 'D.']])
    const engine = makeStubEngine({})
    let cancel = false
    const result = await preSynthesizeBook({
      bookId: newBookId(),
      chapters,
      voiceId: 'en_US-hfc_female-medium' as VoiceId,
      engine,
      onProgress: (done) => {
        if (done === 2) cancel = true
      },
      isCancelled: () => cancel,
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
})
