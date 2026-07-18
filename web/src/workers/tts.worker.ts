import { PiperEngine } from '../lib/tts/engine'
import type { TtsRequest, TtsResponse } from '../lib/tts/protocol'

console.log('[taletrek] tts worker: module loaded')

const ctx = self as unknown as Worker
const engine = new PiperEngine()

ctx.onmessage = async (event: MessageEvent<TtsRequest>) => {
  const req = event.data
  try {
    switch (req.op) {
      case 'synthesize': {
        const { audio, synthMs, durationSeconds, cacheKey } = await engine.synthesize({
          text: req.text,
          voiceId: req.voiceId,
          returnAudio: req.returnAudio,
          ...(req.bookId !== undefined ? { bookId: req.bookId } : {}),
        })
        const res: TtsResponse = {
          id: req.id,
          type: 'success',
          op: 'synthesize',
          audio,
          synthMs,
          durationSeconds,
          cacheKey,
        }
        ctx.postMessage(res)
        break
      }
      case 'download': {
        await engine.download(req.voiceId, (fraction) => {
          const res: TtsResponse = { id: req.id, type: 'progress', fraction }
          ctx.postMessage(res)
        })
        const res: TtsResponse = { id: req.id, type: 'success', op: 'download' }
        ctx.postMessage(res)
        break
      }
      case 'isStored': {
        const stored = await engine.isStored(req.voiceId)
        const res: TtsResponse = { id: req.id, type: 'success', op: 'isStored', stored }
        ctx.postMessage(res)
        break
      }
      case 'remove': {
        await engine.remove(req.voiceId)
        const res: TtsResponse = { id: req.id, type: 'success', op: 'remove' }
        ctx.postMessage(res)
        break
      }
      case 'clearAllStored': {
        await engine.clearAllStored()
        const res: TtsResponse = { id: req.id, type: 'success', op: 'clearAllStored' }
        ctx.postMessage(res)
        break
      }
    }
  } catch (error) {
    console.error('[taletrek] tts worker error:', error)
    const res: TtsResponse = {
      id: req.id,
      type: 'error',
      message: error instanceof Error ? error.message : 'unknown error',
      ...(error instanceof DOMException ? { name: error.name, code: error.code } : {}),
    }
    ctx.postMessage(res)
  }
}
