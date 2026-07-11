import { PiperEngine } from '../lib/tts/engine'
import type { TtsRequest, TtsResponse } from '../lib/tts/protocol'

const ctx = self as unknown as Worker
const engine = new PiperEngine()

ctx.onmessage = async (event: MessageEvent<TtsRequest>) => {
  const req = event.data
  try {
    switch (req.op) {
      case 'synthesize': {
        const { audio, synthMs } = await engine.synthesize({
          text: req.text,
          voiceId: req.voiceId,
        })
        const res: TtsResponse = { id: req.id, type: 'success', op: 'synthesize', audio, synthMs }
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
    }
  } catch (error) {
    const res: TtsResponse = {
      id: req.id,
      type: 'error',
      message: error instanceof Error ? error.message : 'unknown error',
    }
    ctx.postMessage(res)
  }
}
